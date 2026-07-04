import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import path from "path";
import fs from "fs-extra";
import qrcode from "qrcode";
import { log } from "../utils/logger.js";

const STATUSES = {
  INITIALIZING: "initializing",
  QR_READY: "qr_ready",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  LOADING: "loading",
  AUTH_FAILURE: "auth_failure",
};

// ─── Configuration (surchageable via variables d'env Railway) ───
// IMPORTANT : WWEBJS_DATA_PATH doit pointer vers un volume PERSISTANT Railway
// (ex: /data/.wwebjs_auth), sinon la session est perdue à chaque redéploiement.
const DATA_PATH =
  process.env.WWEBJS_DATA_PATH || path.resolve("./.wwebjs_auth");
const MAX_CONCURRENT_INIT = parseInt(
  process.env.WA_MAX_CONCURRENT_INIT || "3",
  10,
);
const IDLE_TIMEOUT_MS = parseInt(
  process.env.WA_IDLE_TIMEOUT_MS || String(2 * 60 * 60 * 1000),
  10,
); // 2h
const IDLE_CHECK_INTERVAL_MS = 15 * 60 * 1000; // vérifie toutes les 15 min
const RECONNECT_MAX_RETRIES = 5;
const RECONNECT_BASE_DELAY_MS = 5000;
const READY_TIMEOUT_MS = 60_000;

fs.ensureDirSync(DATA_PATH);

const clients = new Map(); // userId -> state
const pendingInits = new Map(); // userId -> Promise (dédoublonne les appels concurrents)

// ─── Semaphore : limite le nombre de Chromium lancés en même temps ───
// Évite qu'un pic de 50 users déclenche 50 Puppeteer d'un coup et fasse OOM.
let activeInits = 0;
const initQueue = [];
const acquireInitSlot = () =>
  new Promise((resolve) => {
    const tryAcquire = () => {
      if (activeInits < MAX_CONCURRENT_INIT) {
        activeInits++;
        resolve();
      } else {
        initQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
const releaseInitSlot = () => {
  activeInits--;
  const next = initQueue.shift();
  if (next) next();
};

const sessionDirFor = (sUserId) => path.join(DATA_PATH, `session-${sUserId}`);

/** Supprime la session locale corrompue/expirée pour forcer un nouveau QR */
const wipeLocalSession = async (sUserId) => {
  try {
    await fs.remove(sessionDirFor(sUserId));
  } catch (err) {
    await log("warn", `Échec suppression session locale : ${err.message}`, {
      userId: sUserId,
    });
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Attend que le client passe à CONNECTED, ou rejette si QR requis / timeout.
 */
const waitForReady = (state, timeoutMs = READY_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    if (state.status === STATUSES.CONNECTED) return resolve(state);

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error("Timeout : le client WhatsApp n'est pas devenu prêt à temps"),
      );
    }, timeoutMs);

    const check = setInterval(() => {
      if (state.status === STATUSES.CONNECTED) {
        cleanup();
        resolve(state);
      } else if (state.status === STATUSES.QR_READY) {
        cleanup();
        reject(new Error("QR_REQUIRED")); // reconnexion impossible sans scan manuel
      } else if (state.status === STATUSES.AUTH_FAILURE) {
        cleanup();
        reject(
          new Error(
            "Authentification WhatsApp échouée, reconnexion manuelle requise",
          ),
        );
      }
    }, 500);

    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(check);
    };
  });

/**
 * Planifie une tentative de reconnexion avec backoff exponentiel.
 */
const scheduleReconnect = (sUserId, io) => {
  const state = clients.get(sUserId);
  if (!state) return;

  state.retryCount = (state.retryCount || 0) + 1;
  if (state.retryCount > RECONNECT_MAX_RETRIES) {
    log(
      "error",
      `Abandon de la reconnexion auto après ${RECONNECT_MAX_RETRIES} tentatives`,
      {
        userId: sUserId,
      },
    );
    return;
  }

  const delay = RECONNECT_BASE_DELAY_MS * 2 ** (state.retryCount - 1);
  log(
    "info",
    `Reconnexion planifiée dans ${delay}ms (tentative ${state.retryCount})`,
    {
      userId: sUserId,
    },
  );

  setTimeout(async () => {
    clients.delete(sUserId);
    try {
      await getOrCreateClient(sUserId, io);
    } catch (err) {
      await log("error", `Reconnexion échouée : ${err.message}`, {
        userId: sUserId,
      });
    }
  }, delay);
};

/**
 * Retourne ou crée le client WA pour un userId.
 * Dédoublonne les appels concurrents et limite les lancements Puppeteer simultanés.
 */
export const getOrCreateClient = async (userId, io) => {
  const sUserId = userId.toString();

  if (clients.has(sUserId)) {
    const existing = clients.get(sUserId);
    existing.lastActivityAt = Date.now();
    return existing;
  }

  if (pendingInits.has(sUserId)) {
    return pendingInits.get(sUserId);
  }

  const initPromise = (async () => {
    await acquireInitSlot();
    try {
      return await buildClient(sUserId, io);
    } finally {
      releaseInitSlot();
      pendingInits.delete(sUserId);
    }
  })();

  pendingInits.set(sUserId, initPromise);
  return initPromise;
};

const buildClient = async (sUserId, io) => {
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: sUserId,
      dataPath: DATA_PATH,
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
      ],
    },
  });

  const state = {
    client,
    status: STATUSES.INITIALIZING,
    qr: null,
    retryCount: 0,
    lastActivityAt: Date.now(),
  };
  clients.set(sUserId, state);

  client.on("qr", async (qr) => {
    const qrImage = await qrcode.toDataURL(qr);
    state.status = STATUSES.QR_READY;
    state.qr = qrImage;
    state.retryCount = 0; // un nouveau QR = on repart de zéro
    io?.to(`user:${sUserId}`).emit("wa:qr", { qr: qrImage });
    await log("info", "QR code généré, scan requis", { userId: sUserId });
  });

  client.on("loading_screen", () => {
    state.status = STATUSES.LOADING;
    io?.to(`user:${sUserId}`).emit("wa:status", { status: STATUSES.LOADING });
  });

  client.on("authenticated", () => {
    state.qr = null;
    io?.to(`user:${sUserId}`).emit("wa:status", { status: "authenticated" });
    log("success", "WhatsApp authentifié", { userId: sUserId });
  });

  client.on("ready", () => {
    state.status = STATUSES.CONNECTED;
    state.retryCount = 0;
    state.lastActivityAt = Date.now();
    io?.to(`user:${sUserId}`).emit("wa:status", { status: STATUSES.CONNECTED });
    log("success", "WhatsApp connecté et prêt", { userId: sUserId });
  });

  client.on("disconnected", async (reason) => {
    state.status = STATUSES.DISCONNECTED;
    state.qr = null;
    io?.to(`user:${sUserId}`).emit("wa:status", {
      status: STATUSES.DISCONNECTED,
      reason,
    });
    await log("warn", `WhatsApp déconnecté : ${reason}`, { userId: sUserId });

    try {
      await client.destroy();
    } catch {}
    clients.delete(sUserId);

    // LOGOUT = l'utilisateur a délié l'appareil depuis son téléphone.
    // Inutile de retenter : la session locale est invalide, il faut un nouveau QR.
    if (String(reason).toUpperCase().includes("LOGOUT")) {
      await wipeLocalSession(sUserId);
      await log("warn", "Session invalidée (logout), nouveau QR requis", {
        userId: sUserId,
      });
      return;
    }

    // Sinon (perte réseau, navigation, etc.) → on retente automatiquement
    scheduleReconnect(sUserId, io);
  });

  client.on("auth_failure", async (msg) => {
    state.status = STATUSES.AUTH_FAILURE;
    io?.to(`user:${sUserId}`).emit("wa:status", {
      status: "auth_failure",
      msg,
    });
    await log("error", `Échec d'authentification WhatsApp : ${msg}`, {
      userId: sUserId,
    });
    await wipeLocalSession(sUserId);
    clients.delete(sUserId);
  });

  await client.initialize();
  return state;
};

/**
 * Publie un statut WhatsApp (texte + image optionnelle).
 * Tente une reconnexion à la volée si le client est éteint (ex: nettoyé pour inactivité).
 */
export const publishStatus = async (userId, { text, imageUrl }, io) => {
  const sUserId = userId.toString();

  let state = clients.get(sUserId);

  if (!state || state.status !== STATUSES.CONNECTED) {
    log("info", "Client non actif, tentative de reconnexion à la volée", {
      userId: sUserId,
    });
    try {
      state = await getOrCreateClient(sUserId, io);
      await waitForReady(state);
    } catch (err) {
      if (err.message === "QR_REQUIRED") {
        throw new Error(
          "Compte WhatsApp déconnecté : reconnexion manuelle (scan QR) requise",
        );
      }
      throw new Error(`Client WhatsApp non connecté : ${err.message}`);
    }
  }

  state.lastActivityAt = Date.now();
  const { client } = state;

  if (imageUrl) {
    const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
    await client.sendMessage("status@broadcast", media, { caption: text });
  } else {
    await client.sendMessage("status@broadcast", text);
  }

  await log("success", "Statut WhatsApp publié", { userId: sUserId });
};

export const destroyClient = async (userId) => {
  const sUserId = userId.toString();
  const state = clients.get(sUserId);
  if (!state) return;
  try {
    await state.client.destroy();
  } catch {}
  clients.delete(sUserId);
  await log("info", "Client WhatsApp détruit", { userId: sUserId });
};

export const getClientStatus = (userId) => {
  const sUserId = userId.toString();
  const state = clients.get(sUserId);
  if (!state) return { status: STATUSES.DISCONNECTED, qr: null };
  return { status: state.status, qr: state.qr };
};

/**
 * Initialise les clients au démarrage, avec un délai entre chaque
 * pour ne pas lancer 50 Chromium en même temps (le semaphore limite déjà
 * la concurrence, mais l'étalement évite aussi de saturer MongoDB/réseau
 * au boot).
 */
export const initAllClients = async (users, io) => {
  for (const user of users) {
    try {
      await getOrCreateClient(user._id.toString(), io);
    } catch (err) {
      await log(
        "error",
        `Init client échoué pour ${user.email} : ${err.message}`,
        {
          userId: user._id,
        },
      );
    }
    await sleep(1000); // étalement léger, en plus du semaphore
  }
};

/**
 * Nettoyage périodique des clients inactifs pour libérer la RAM.
 * La session reste sur disque (LocalAuth) : le prochain appel à publishStatus
 * relance le client automatiquement, sans re-scan de QR.
 */
export const startIdleCleanup = () => {
  setInterval(async () => {
    const now = Date.now();
    for (const [sUserId, state] of clients.entries()) {
      if (
        state.status === STATUSES.CONNECTED &&
        now - state.lastActivityAt > IDLE_TIMEOUT_MS
      ) {
        await log("info", "Nettoyage client inactif (libération RAM)", {
          userId: sUserId,
        });
        try {
          await state.client.destroy();
        } catch {}
        clients.delete(sUserId);
      }
    }
  }, IDLE_CHECK_INTERVAL_MS);
};

/**
 * Filet de sécurité process-level : log proprement puis quitte,
 * pour laisser Railway redémarrer le service au lieu de rester
 * bloqué dans un état corrompu (cas nodemon en dev).
 * À appeler UNE FOIS au tout début de index.js.
 */
export const attachProcessSafetyNet = () => {
  process.on("uncaughtException", async (err) => {
    await log(
      "error",
      `Exception non gérée, arrêt du process : ${err.message}`,
      {
        details: err.stack,
      },
    );
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    await log("error", `Rejet de promesse non géré : ${reason}`, {
      details: reason?.stack || String(reason),
    });
  });
};
