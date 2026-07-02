import pkg from "whatsapp-web.js";
const { Client, MessageMedia } = pkg;
import { MongoStore } from "wwebjs-mongo";
import mongoose from "mongoose";
import qrcode from "qrcode";
import { log } from "../utils/logger.js";
const clients = new Map();

const STATUSES = {
  INITIALIZING: "initializing",
  QR_READY: "qr_ready",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  LOADING: "loading",
};

/**
 * Retourne ou crée le client WA pour un userId
 */
export const getOrCreateClient = async (userId, io) => {
  if (clients.has(userId)) return clients.get(userId);

  const store = new MongoStore({ mongoose });

  // ✅ CORRIGÉ : On extrait RemoteAuth proprement depuis notre constante pkg du haut
  const { RemoteAuth } = pkg;

  const client = new Client({
    authStrategy: new RemoteAuth({
      clientId: userId,
      store,
      backupSyncIntervalMs: 300_000,
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--ipv4-first", // <-- Recommandé pour éviter tout freeze DNS résiduel lors de la sync
      ],
    },
  });

  const state = { client, status: STATUSES.INITIALIZING, qr: null };
  clients.set(userId, state);

  // --- Events ---
  client.on("qr", async (qr) => {
    const qrImage = await qrcode.toDataURL(qr);
    state.status = STATUSES.QR_READY;
    state.qr = qrImage;
    io?.to(`user:${userId}`).emit("wa:qr", { qr: qrImage });
    await log("info", "QR code généré, scan requis", { userId });
  });

  client.on("loading_screen", () => {
    state.status = STATUSES.LOADING;
    io?.to(`user:${userId}`).emit("wa:status", { status: STATUSES.LOADING });
  });

  client.on("authenticated", () => {
    state.qr = null;
    io?.to(`user:${userId}`).emit("wa:status", { status: "authenticated" });
    log("success", "WhatsApp authentifié", { userId });
  });

  client.on("ready", () => {
    state.status = STATUSES.CONNECTED;
    io?.to(`user:${userId}`).emit("wa:status", { status: STATUSES.CONNECTED });
    log("success", "WhatsApp connecté et prêt", { userId });
  });

  client.on("disconnected", async (reason) => {
    state.status = STATUSES.DISCONNECTED;
    state.qr = null;
    io?.to(`user:${userId}`).emit("wa:status", {
      status: STATUSES.DISCONNECTED,
      reason,
    });
    await log("warn", `WhatsApp déconnecté : ${reason}`, { userId });
    clients.delete(userId);
  });

  await client.initialize();
  return state;
};

/**
 * Publie un statut WhatsApp (texte + image optionnelle)
 */
export const publishStatus = async (userId, { text, imageUrl }) => {
  const state = clients.get(userId);
  if (!state || state.status !== STATUSES.CONNECTED) {
    throw new Error("Client WhatsApp non connecté");
  }

  const { client } = state;

  if (imageUrl) {
    const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
    await client.sendMessage("status@broadcast", media, { caption: text });
  } else {
    await client.sendMessage("status@broadcast", text);
  }

  await log("success", "Statut WhatsApp publié", { userId });
};

/**
 * Déconnecte et détruit le client d'un user
 */
export const destroyClient = async (userId) => {
  const state = clients.get(userId);
  if (!state) return;
  try {
    await state.client.destroy();
  } catch {}
  clients.delete(userId);
  await log("info", "Client WhatsApp détruit", { userId });
};

/**
 * Statut courant d'un user
 */
export const getClientStatus = (userId) => {
  const state = clients.get(userId);
  if (!state) return { status: STATUSES.DISCONNECTED, qr: null };
  return { status: state.status, qr: state.qr };
};

/**
 * Initialise les clients de tous les users actifs au démarrage
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
  }
};
