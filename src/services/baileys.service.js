import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode";
import pino from "pino";

import { log } from "../utils/logger.js";
import { env } from "../config/env.js";
import User from "../models/User.js";
import Contact from "../models/Contact.js";
import Message from "../models/Message.js";
import { generateReply, transcribeAudio } from "./ai.service.js";
import { useMongoAuthState, clearAuthState } from "./mongoAuthState.service.js";
import { humanDelay } from "../helpers/humanDelay.js";

// ─────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────

const STATUSES = {
  INITIALIZING: "initializing",
  QR_READY: "qr_ready",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  CONFLICT: "conflict",
};

const RECONNECT_DELAY_MS = 5_000;
const PROCESSED_IDS_MAX = 500;

const IGNORED_MESSAGE_TYPES = new Set([
  "protocolMessage",
  "reactionMessage",
  "pollUpdateMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "ephemeralMessage",
  "senderKeyDistributionMessage",
]);

const silentLogger = pino({ level: "silent" });

// Version Baileys figée une seule fois par process, pas re-fetchée à chaque reconnexion
let cachedVersion = null;
const getBaileysVersion = async () => {
  if (!cachedVersion) {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = version;
  }
  return cachedVersion;
};

// ─────────────────────────────────────────────
// State interne
// ─────────────────────────────────────────────

const sessions = new Map();
const pendingInits = new Map();

// Flag global — empêche toute reconnexion pendant un arrêt volontaire du process
let isShuttingDown = false;
export const setShuttingDown = () => {
  isShuttingDown = true;
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const normalizePhone = (value) =>
  value?.toString().replace("@s.whatsapp.net", "").replace(/\D/g, "") ?? "";

const getMessageType = (message) => {
  if (message.conversation != null || message.extendedTextMessage?.text != null)
    return "text";
  if (message.imageMessage) return "image";
  if (message.videoMessage) return "video";
  if (message.audioMessage) return "audio";
  if (message.documentMessage) return "document";
  if (message.stickerMessage) return "sticker";
  return "unsupported";
};

const isBotMentioned = (msg, ownJid) => {
  if (!ownJid) return false;
  const contextInfo =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    msg.message?.audioMessage?.contextInfo ||
    null;
  const mentioned = contextInfo?.mentionedJid ?? [];
  const ownNumber = ownJid.split("@")[0];
  return mentioned.some((jid) => jid.split("@")[0] === ownNumber);
};

const buildFallbackMessage = (businessName, reason) => {
  const base = `Bonjour, je suis l'assistant automatique de ${businessName}. Un membre de l'équipe vous répondra dès que possible.`;
  if (reason === "image")
    return `${base} Je ne peux pas traiter les images pour le moment.`;
  if (reason === "audio")
    return `${base} Je n'ai pas pu traiter votre message vocal.`;
  return base;
};

const handleIncomingMessage = async (sUserId, session, msg, io) => {
  if (!msg.message) return;

  const msgKeys = Object.keys(msg.message);
  if (msgKeys.some((k) => IGNORED_MESSAGE_TYPES.has(k))) return;

  const remoteJid = msg.key.remoteJid;
  const isFromMe = msg.key.fromMe;
  const isGroup = remoteJid.endsWith("@g.us");
  const messageType = getMessageType(msg.message);

  if (isGroup && !isBotMentioned(msg, session.ownJid)) return;

  let text = "";
  let mediaFallbackReason = null;

  if (messageType === "text") {
    text =
      msg.message.conversation || msg.message.extendedTextMessage?.text || "";
  } else if (messageType === "image" || messageType === "video") {
    const captionKey =
      messageType === "image" ? "imageMessage" : "videoMessage";
    text = msg.message[captionKey]?.caption || "";
    if (!text.trim()) mediaFallbackReason = "image";
  } else if (messageType === "audio") {
    try {
      const buffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        {
          logger: silentLogger,
          reuploadRequest: session.sock.updateMediaMessage,
        },
      );
      const rawMime = msg.message.audioMessage?.mimetype || "audio/ogg";
      const mimeType = rawMime.split(";")[0].trim();
      const transcript = await transcribeAudio(buffer, mimeType);
      text = (transcript || "").trim();
      if (!text) mediaFallbackReason = "audio";
    } catch (err) {
      await log("error", `Transcription audio échouée : ${err.message}`, {
        userId: sUserId,
      });
      mediaFallbackReason = "audio";
    }
  } else {
    return;
  }

  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z!.]/g, "");

  if (
    isFromMe &&
    (normalized === "!stop" || normalized === "!start" || normalized === ".stop" || normalized === ".start")
  ) {
    const botEnabled = normalized === "!start" || normalized === ".start";
    await User.findByIdAndUpdate(sUserId, { botEnabled });
    io?.to(`user:${sUserId}`).emit("bot:status", { botEnabled });
    await log(
      "info",
      `Bot ${botEnabled ? "réactivé" : "mis en pause"} via commande WhatsApp`,
      { userId: sUserId },
    );
    // Confirmation uniquement envoyée au chat qui a émis la commande
    await humanDelay();
    await session.sock.sendMessage(remoteJid, { text: "✅ Reçu." });
    return;
  }

  if (isFromMe) return;

  const user = await User.findById(sUserId);
  if (!user?.botEnabled) return;

  const pushName = msg.pushName?.trim() || null;

  const existingContact = await Contact.findOne({
    userId: sUserId,
    waId: remoteJid,
  });

  // Robust match: Baileys peut stocker des JID (with @s.whatsapp.net) ou d'autres formes.
  const wifeWaIdRaw = (env.wifeWaId || "").toString();
  const wifeWaIdJid = wifeWaIdRaw.includes("@") ? wifeWaIdRaw : `${wifeWaIdRaw}@s.whatsapp.net`;
  const normalizeDigits = (v) => v?.toString().replace(/\D/g, "") ?? "";
  const remoteDigits = normalizeDigits(remoteJid);
  const wifeDigits = normalizeDigits(wifeWaIdRaw);

  const isWife = !!wifeWaIdRaw && (
    remoteJid === wifeWaIdRaw || // exact match
    remoteJid === wifeWaIdJid || // match with @s.whatsapp.net
    (remoteDigits && wifeDigits && remoteDigits === wifeDigits) || // digits match
    (wifeWaIdRaw && remoteJid.includes(wifeWaIdRaw)) || // partial inclusion
    (wifeDigits && remoteJid.includes(wifeDigits)) // digits inclusion
  );

  const relationshipField = existingContact?.relationship
    ? {}
    : isWife
    ? { relationship: "wife" }
    : { relationship: null };

  const contact = await Contact.findOneAndUpdate(
    { userId: sUserId, waId: remoteJid },
    {
      lastInteractionAt: new Date(),
      ...(pushName ? { name: pushName } : {}),
      ...relationshipField,
    },
    { upsert: true, new: true },
  );

  if (mediaFallbackReason) {
    const fallback = buildFallbackMessage(
      user.businessName,
      mediaFallbackReason,
    );

    await Message.create({
      userId: sUserId,
      contactId: contact._id,
      direction: "in",
      text: `[${messageType}] (non traité)`,
    });
    await humanDelay();
    await session.sock.sendMessage(remoteJid, { text: fallback });
    await Message.create({
      userId: sUserId,
      contactId: contact._id,
      direction: "out",
      text: fallback,
    });
    io?.to(`user:${sUserId}`).emit("conversation:update", {
      contactId: contact._id,
    });
    return;
  }

  if (!text.trim()) return;

  await Message.create({
    userId: sUserId,
    contactId: contact._id,
    direction: "in",
    text,
  });

  const reply = await generateReply(user, contact, text);

  await humanDelay();
  await session.sock.sendMessage(remoteJid, { text: reply });
  await Message.create({
    userId: sUserId,
    contactId: contact._id,
    direction: "out",
    text: reply,
  });
  io?.to(`user:${sUserId}`).emit("conversation:update", {
    contactId: contact._id,
  });
};

// ─────────────────────────────────────────────
// Construction de session Baileys
// ─────────────────────────────────────────────

const buildSession = async (sUserId, io) => {
  const { state, saveCreds } = await useMongoAuthState(sUserId);
  const version = await getBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    logger: silentLogger,
    printQRInTerminal: false,
    version,
    // Fingerprint FIXE — ne jamais changer entre process/redéploiements,
    // un fingerprint instable augmente la suspicion côté WhatsApp.
    browser: Browsers.macOS("Chrome"),
    markOnlineOnConnect: false,
  });

  const session = {
    sock,
    status: STATUSES.INITIALIZING,
    qr: null,
    ownJid: null,
    processedMsgIds: new Set(),
  };

  sessions.set(sUserId, session);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on(
    "connection.update",
    async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        session.qr = await qrcode.toDataURL(qr);
        session.status = STATUSES.QR_READY;
        io?.to(`user:${sUserId}`).emit("wa:qr", { qr: session.qr });
        await log("info", "QR code généré, scan requis", { userId: sUserId });
      }

      if (connection === "open") {
        session.status = STATUSES.CONNECTED;
        session.qr = null;
        session.ownJid = `${sock.user?.id?.split(":")[0]}@s.whatsapp.net`;
        io?.to(`user:${sUserId}`).emit("wa:status", {
          status: STATUSES.CONNECTED,
        });
        await log("success", "Baileys connecté et prêt", { userId: sUserId });
      }

      if (connection === "close") {
        // Arrêt volontaire du process (déploiement) — ne rien entreprendre,
        // laisser gracefulShutdown gérer la fermeture des sockets.
        if (isShuttingDown) return;

        session.status = STATUSES.DISCONNECTED;
        sessions.delete(sUserId);

        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        io?.to(`user:${sUserId}`).emit("wa:status", {
          status: STATUSES.DISCONNECTED,
        });
        await log("warn", `Baileys déconnecté (code ${statusCode})`, {
          userId: sUserId,
        });

        if (statusCode === DisconnectReason.loggedOut) {
          await clearAuthState(sUserId);
          await log(
            "warn",
            "Session invalidée (logout) — nouveau scan QR requis",
            { userId: sUserId },
          );
          return;
        }

        if (statusCode === DisconnectReason.connectionReplaced) {
          // Une autre socket tient déjà cette session — NE JAMAIS reconnecter
          // automatiquement ici, sous peine de boucle de conflit infinie.
          session.status = STATUSES.CONFLICT;
          io?.to(`user:${sUserId}`).emit("wa:status", {
            status: STATUSES.CONFLICT,
          });
          await log(
            "error",
            "Conflit détecté : session déjà active ailleurs — reconnexion annulée",
            { userId: sUserId },
          );
          return;
        }

        // Tout autre motif (timeout réseau, restart requis après premier scan, etc.)
        setTimeout(() => getOrCreateSession(sUserId, io), RECONNECT_DELAY_MS);
      }
    },
  );

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      const msgId = msg.key?.id;
      if (msgId) {
        if (session.processedMsgIds.has(msgId)) continue;
        session.processedMsgIds.add(msgId);

        if (session.processedMsgIds.size > PROCESSED_IDS_MAX) {
          session.processedMsgIds.delete(
            session.processedMsgIds.values().next().value,
          );
        }
      }

      try {
        await handleIncomingMessage(sUserId, session, msg, io);
      } catch (err) {
        await log("error", `Erreur traitement message : ${err.message}`, {
          userId: sUserId,
        });
      }
    }
  });

  return session;
};

// ─────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────

export const getSessionStatus = (userId) => {
  const s = sessions.get(userId.toString());
  return s
    ? { status: s.status, qr: s.qr }
    : { status: STATUSES.DISCONNECTED, qr: null };
};

export const getOrCreateSession = async (userId, io) => {
  if (isShuttingDown) {
    throw new Error("Process en cours d'arrêt, nouvelle session refusée");
  }

  const sUserId = userId.toString();
  if (sessions.has(sUserId)) return sessions.get(sUserId);
  if (pendingInits.has(sUserId)) return pendingInits.get(sUserId);

  const promise = buildSession(sUserId, io).finally(() =>
    pendingInits.delete(sUserId),
  );
  pendingInits.set(sUserId, promise);
  return promise;
};

// Exportés pour tests/simulations
export { handleIncomingMessage, normalizePhone };

/**
 * Déconnecte proprement un utilisateur et supprime sa session MongoDB
 * (creds + toutes les clés). Un nouveau scan QR sera nécessaire.
 */
export const destroySession = async (userId) => {
  const sUserId = userId.toString();
  const session = sessions.get(sUserId);

  if (session) {
    try {
      await session.sock.logout();
    } catch {
      /* déjà déconnecté */
    }
    sessions.delete(sUserId);
    pendingInits.delete(sUserId);
  }

  await clearAuthState(sUserId);
  await log("info", "Session WhatsApp détruite", { userId: sUserId });
};

/**
 * Ferme proprement toutes les sockets actives SANS invalider les sessions
 * (pas de logout). À utiliser uniquement lors d'un arrêt volontaire du
 * process (SIGTERM), pour laisser le temps aux dernières écritures Mongo
 * de se terminer avant que Railway ne tue le conteneur.
 */
export const closeAllSessions = async () => {
  for (const [userId, session] of sessions.entries()) {
    try {
      session.sock.end(undefined);
    } catch (err) {
      await log("warn", `Erreur fermeture socket pour ${userId} : ${err.message}`, {
        userId,
      });
    }
  }
  await new Promise((r) => setTimeout(r, 1_500));
};

export const initAllSessions = async (users, io) => {
  for (const user of users) {
    try {
      await getOrCreateSession(user._id.toString(), io);
    } catch (err) {
      await log(
        "error",
        `Init session échouée pour ${user.email} : ${err.message}`,
        { userId: user._id },
      );
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
};

export { sessions };