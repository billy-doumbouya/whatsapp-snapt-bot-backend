import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode";
import path from "path";
import fs from "fs-extra";
import pino from "pino";
import { env } from "../config/env.js";
import { log } from "../utils/logger.js";
import User from "../models/User.js";
import Contact from "../models/Contact.js";
import Message from "../models/Message.js";
import { generateReply, transcribeAudio } from "./ai.service.js";

const STATUSES = {
  INITIALIZING: "initializing",
  QR_READY: "qr_ready",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
};

const AUTH_PATH = path.resolve(env.waDataPath);
fs.ensureDirSync(AUTH_PATH);

const sessions = new Map(); // userId -> { sock, status, qr, ownJid }
const pendingInits = new Map();

const sessionPath = (userId) => path.join(AUTH_PATH, `session-${userId}`);

const silentLogger = pino({ level: "silent" });

export const getSessionStatus = (userId) => {
  const s = sessions.get(userId.toString());
  if (!s) return { status: STATUSES.DISCONNECTED, qr: null };
  return { status: s.status, qr: s.qr };
};

export const getOrCreateSession = async (userId, io) => {
  const sUserId = userId.toString();

  if (sessions.has(sUserId)) return sessions.get(sUserId);
  if (pendingInits.has(sUserId)) return pendingInits.get(sUserId);

  const initPromise = buildSession(sUserId, io).finally(() =>
    pendingInits.delete(sUserId),
  );
  pendingInits.set(sUserId, initPromise);
  return initPromise;
};

const buildSession = async (sUserId, io) => {
  const { state, saveCreds } = await useMultiFileAuthState(
    sessionPath(sUserId),
  );

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    logger: silentLogger,
    printQRInTerminal: false,
    version,
    markOnlineOnConnect: false,
  });

  const session = {
    sock,
    status: STATUSES.INITIALIZING,
    qr: null,
    ownJid: null,
  };
  sessions.set(sUserId, session);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qr = await qrcode.toDataURL(qr);
      session.status = STATUSES.QR_READY;
      io?.to(`user:${sUserId}`).emit("wa:qr", { qr: session.qr });
      await log("info", "QR code généré, scan requis", { userId: sUserId });
    }

    if (connection === "open") {
      session.status = STATUSES.CONNECTED;
      session.qr = null;
      session.ownJid = sock.user?.id?.split(":")[0] + "@s.whatsapp.net";
      io?.to(`user:${sUserId}`).emit("wa:status", {
        status: STATUSES.CONNECTED,
      });
      await log("success", "Baileys connecté et prêt", { userId: sUserId });
    }

    if (connection === "close") {
      session.status = STATUSES.DISCONNECTED;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      io?.to(`user:${sUserId}`).emit("wa:status", {
        status: STATUSES.DISCONNECTED,
      });
      await log("warn", `Baileys déconnecté (code ${statusCode})`, {
        userId: sUserId,
      });

      sessions.delete(sUserId);

      if (statusCode === DisconnectReason.loggedOut) {
        await fs.remove(sessionPath(sUserId));
        await log("warn", "Session invalidée (logout), nouveau QR requis", {
          userId: sUserId,
        });
        return;
      }

      // Reconnexion auto sur toute autre déconnexion (réseau, etc.)
      setTimeout(() => getOrCreateSession(sUserId, io), 5000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
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

/** Détecte le type de contenu du message entrant */
const getMessageType = (message) => {
  if (message.conversation || message.extendedTextMessage) return "text";
  if (message.imageMessage) return "image";
  if (message.videoMessage) return "video";
  if (message.audioMessage) return "audio";
  if (message.documentMessage) return "document";
  if (message.stickerMessage) return "sticker";
  return "unsupported";
};

/** Vérifie si le bot (le numéro connecté) est explicitement mentionné dans un message de groupe */
const isBotMentioned = (msg, ownJid) => {
  if (!ownJid) return false;
  const contextInfo =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    msg.message?.audioMessage?.contextInfo;
  const mentioned = contextInfo?.mentionedJid || [];
  const ownNumber = ownJid.split("@")[0];
  return mentioned.some((jid) => jid.split("@")[0] === ownNumber);
};

/** Message de repli quand le bot ne peut pas traiter le contenu (image/audio non exploitable) */
const buildFallbackMessage = (businessName, reason) => {
  const base = `Bonjour, je suis l'assistant automatique de ${businessName}. Un membre de l'équipe vous répondra dès que possible.`;
  if (reason === "image") {
    return `${base} Je n'ai pas la permission de traiter les images pour le moment.`;
  }
  if (reason === "audio") {
    return `${base} Je n'ai pas pu traiter votre message vocal pour le moment.`;
  }
  return `${base} Je ne peux pas traiter ce type de message pour le moment.`;
};

/**
 * Traite un message entrant.
 * - Si c'est le propriétaire qui s'écrit "stop"/"start" à lui-même : bascule botEnabled
 * - Si groupe : ignore sauf mention explicite du numéro du bot
 * - Si image/vidéo avec légende : répond selon la légende
 * - Si image/vidéo sans légende : message de repli (pas de traitement d'image)
 * - Si audio : transcription puis réponse ; repli si transcription impossible
 * - Sinon, si botEnabled : génère une réponse IA et l'envoie
 */
const handleIncomingMessage = async (sUserId, session, msg, io) => {
  if (!msg.message) return;

  const remoteJid = msg.key.remoteJid;
  const isFromMe = msg.key.fromMe;
  const isGroup = remoteJid.endsWith("@g.us");
  const messageType = getMessageType(msg.message);

  // ─── Groupes : on ignore sauf mention explicite du numéro du bot ───
  if (isGroup) {
    const mentioned = isBotMentioned(msg, session.ownJid);
    if (!mentioned) return;
  }

  // ─── Extraction du texte selon le type de contenu ───
  let text = "";
  let mediaFallbackReason = null;

  if (messageType === "text") {
    text =
      msg.message.conversation || msg.message.extendedTextMessage?.text || "";
  } else if (messageType === "image") {
    text = msg.message.imageMessage?.caption || "";
    if (!text.trim()) mediaFallbackReason = "image";
  } else if (messageType === "video") {
    text = msg.message.videoMessage?.caption || "";
    if (!text.trim()) mediaFallbackReason = "image"; // même repli que les images
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
      const mimeType = msg.message.audioMessage?.mimetype || "audio/ogg";
      const transcript = await transcribeAudio(buffer, mimeType);
      text = (transcript || "").trim();
      if (!text) mediaFallbackReason = "audio";
    } catch (err) {
      await log("error", `Erreur transcription audio : ${err.message}`, {
        userId: sUserId,
      });
      mediaFallbackReason = "audio";
    }
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
      const rawMimeType = msg.message.audioMessage?.mimetype || "audio/ogg";
      const mimeType = rawMimeType.split(";")[0].trim(); // ← nettoie "audio/ogg; codecs=opus" → "audio/ogg"
      const transcript = await transcribeAudio(buffer, mimeType);
      text = (transcript || "").trim();
      if (!text) mediaFallbackReason = "audio";
    } catch (err) {
      await log("error", `Erreur transcription audio : ${err.message}`, {
        userId: sUserId,
      });
      mediaFallbackReason = "audio";
    }
  } else {
    // documents, stickers, etc. : non supportés
    mediaFallbackReason = "unsupported";
  }

  const normalized = text.trim().toLowerCase();

  // ─── Canal de contrôle : le propriétaire s'écrit à lui-même ───
  const isSelfChat = isFromMe && remoteJid === session.ownJid;
  if (isSelfChat && (normalized === "stop" || normalized === "start")) {
    const botEnabled = normalized === "start";
    await User.findByIdAndUpdate(sUserId, { botEnabled });
    io?.to(`user:${sUserId}`).emit("bot:status", { botEnabled });
    await log(
      "info",
      `Bot ${botEnabled ? "réactivé" : "mis en pause"} via commande WhatsApp`,
      { userId: sUserId },
    );
    return;
  }

  if (isFromMe) return; // ignore les autres messages envoyés par le propriétaire lui-même

  const user = await User.findById(sUserId);
  if (!user || !user.botEnabled) return; // bot coupé : silence total

  // ─── Trouver/créer le contact ───
  const contact = await Contact.findOneAndUpdate(
    { userId: sUserId, waId: remoteJid },
    { lastInteractionAt: new Date() },
    { upsert: true, new: true },
  );

  // ─── Cas média non exploitable : message de repli, pas d'appel IA ───
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

  if (!text.trim()) return; // sécurité supplémentaire, ne devrait plus arriver ici

  await Message.create({
    userId: sUserId,
    contactId: contact._id,
    direction: "in",
    text,
  });

  const reply = await generateReply(user, contact._id, text);

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

export const initAllSessions = async (users, io) => {
  for (const user of users) {
    try {
      await getOrCreateSession(user._id.toString(), io);
    } catch (err) {
      await log(
        "error",
        `Init session échouée pour ${user.email} : ${err.message}`,
        {
          userId: user._id,
        },
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
};

export const destroySession = async (userId) => {
  const sUserId = userId.toString();
  const session = sessions.get(sUserId);
  if (!session) return;

  try {
    await session.sock.logout();
  } catch {}

  sessions.delete(sUserId);
  pendingInits.delete(sUserId);

  await fs.remove(sessionPath(sUserId));
};
