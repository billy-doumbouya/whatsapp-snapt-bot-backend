import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode";
import pino from "pino";

import { log } from "../utils/logger.js";
import { env } from "../config/env.js";
import User from "../models/User.js";
import Contact from "../models/Contact.js";
import Message from "../models/Message.js";
import WhatsAppAuth from "../models/WhatsAppAuth.js";
import { generateReply, transcribeAudio } from "./ai.service.js";
import { useMongoAuthState } from "./mongoAuthState.service.js";

// ─────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────

const STATUSES = {
  INITIALIZING: "initializing",
  QR_READY: "qr_ready",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
};

const RECONNECT_DELAY_MS = 5_000;
const PROCESSED_IDS_MAX = 500;

/**
 * Types de messages système WhatsApp à ignorer silencieusement.
 * Aucune réponse ne doit être envoyée pour ces types.
 */
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

// ─────────────────────────────────────────────
// State interne
// ─────────────────────────────────────────────

/** userId (string) → { sock, status, qr, ownJid, processedMsgIds } */
const sessions = new Map();

/** userId (string) → Promise<session> — évite les initialisations concurrentes */
const pendingInits = new Map();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Normalise un identifiant WhatsApp en numéro de téléphone pur (chiffres uniquement).
 * Gère les formats JID (@s.whatsapp.net), E.164 (+224…) et locaux.
 */
const normalizePhone = (value) =>
  value?.toString().replace("@s.whatsapp.net", "").replace(/\D/g, "") ?? "";

/**
 * Extrait le type de contenu utile d'un objet `message` Baileys.
 * Retourne "unsupported" si aucun type connu n'est détecté.
 */
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

/**
 * Vérifie si le bot est explicitement mentionné (@mention) dans un message de groupe.
 */
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

/**
 * Construit le message de repli envoyé quand le bot ne peut pas traiter un média.
 * Réservé aux cas où le bot a tenté un traitement (image sans légende, audio non transcrit).
 */
const buildFallbackMessage = (businessName, reason) => {
  const base = `Bonjour, je suis l'assistant automatique de ${businessName}. Un membre de l'équipe vous répondra dès que possible.`;
  if (reason === "image")
    return `${base} Je ne peux pas traiter les images pour le moment.`;
  if (reason === "audio")
    return `${base} Je n'ai pas pu traiter votre message vocal.`;
  return base;
};

// ─────────────────────────────────────────────
// Gestion des messages entrants
// ─────────────────────────────────────────────

const handleIncomingMessage = async (sUserId, session, msg, io) => {
  if (!msg.message) return;

  // 1. Ignorer les messages système WhatsApp (réactions, protocole, éphémères…)
  const msgKeys = Object.keys(msg.message);
  if (msgKeys.some((k) => IGNORED_MESSAGE_TYPES.has(k))) return;

  const remoteJid = msg.key.remoteJid;
  const isFromMe = msg.key.fromMe;
  const isGroup = remoteJid.endsWith("@g.us");
  const messageType = getMessageType(msg.message);

  // 2. Groupes : répondre uniquement si le bot est explicitement mentionné
  if (isGroup && !isBotMentioned(msg, session.ownJid)) return;

  // 3. Extraction du contenu textuel selon le type de message
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
    // sticker, document, type inconnu → silence total, pas de fallback
    return;
  }

  // 4. Commandes de contrôle : !stop / !start (propriétaire uniquement)
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z!]/g, "");

  if (isFromMe && (normalized === "!stop" || normalized === "!start")) {
    const botEnabled = normalized === "!start";
    await User.findByIdAndUpdate(sUserId, { botEnabled });
    io?.to(`user:${sUserId}`).emit("bot:status", { botEnabled });
    await log(
      "info",
      `Bot ${botEnabled ? "réactivé" : "mis en pause"} via commande WhatsApp`,
      { userId: sUserId },
    );
    return;
  }

  // 5. Accusé de réception pour les messages texte du propriétaire
  if (isFromMe && messageType === "text" && text.trim()) {
    await session.sock.sendMessage(remoteJid, { text: "✅ Reçu." });
    return;
  }

  // 6. Ignorer tous les autres messages envoyés par le propriétaire
  if (isFromMe) return;

  // 7. Vérifier que le bot est actif pour cet utilisateur
  const user = await User.findById(sUserId);
  if (!user?.botEnabled) return;

  // 8. Trouver ou créer le contact
  const pushName = msg.pushName?.trim() || null;
  const isWife = env.wifeWaId
    ? normalizePhone(remoteJid) === normalizePhone(env.wifeWaId)
    : false;

  const contact = await Contact.findOneAndUpdate(
    { userId: sUserId, waId: remoteJid },
    {
      lastInteractionAt: new Date(),
      ...(pushName ? { name: pushName } : {}),
      relationship: isWife ? "wife" : null,
    },
    { upsert: true, new: true },
  );

  // 9. Média non exploitable → message de repli (image sans légende, audio non transcrit)
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

  if (!text.trim()) return;

  // 10. Générer et envoyer la réponse IA
  await Message.create({
    userId: sUserId,
    contactId: contact._id,
    direction: "in",
    text,
  });

  const reply = await generateReply(user, contact, text);

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
    processedMsgIds: new Set(),
  };

  sessions.set(sUserId, session);

  // Persistence des credentials
  sock.ev.on("creds.update", saveCreds);

  // Événements de connexion
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
          await WhatsAppAuth.deleteOne({ userId: sUserId });
          await log(
            "warn",
            "Session invalidée (logout) — nouveau scan QR requis",
            { userId: sUserId },
          );
          return;
        }

        // Reconnexion automatique pour tout autre motif de déconnexion
        setTimeout(() => getOrCreateSession(sUserId, io), RECONNECT_DELAY_MS);
      }
    },
  );

  // Réception des messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // "append" = historique de synchro au reconnect, on l'ignore
    if (type !== "notify") return;

    for (const msg of messages) {
      // Dédoublonnage par msgId (évite les réponses doubles sur reconnect instable)
      const msgId = msg.key?.id;
      if (msgId) {
        if (session.processedMsgIds.has(msgId)) continue;
        session.processedMsgIds.add(msgId);

        // Borne la taille du Set pour éviter une fuite mémoire sur session longue durée
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

/** Retourne le statut courant de la session d'un utilisateur. */
export const getSessionStatus = (userId) => {
  const s = sessions.get(userId.toString());
  return s
    ? { status: s.status, qr: s.qr }
    : { status: STATUSES.DISCONNECTED, qr: null };
};

/**
 * Retourne la session existante ou en crée une nouvelle.
 * Protège contre les appels concurrents grâce à `pendingInits`.
 */
export const getOrCreateSession = async (userId, io) => {
  const sUserId = userId.toString();
  if (sessions.has(sUserId)) return sessions.get(sUserId);
  if (pendingInits.has(sUserId)) return pendingInits.get(sUserId);

  const promise = buildSession(sUserId, io).finally(() =>
    pendingInits.delete(sUserId),
  );
  pendingInits.set(sUserId, promise);
  return promise;
};

/**
 * Déconnecte proprement un utilisateur et supprime sa session MongoDB.
 * Équivaut à un "logout" — un nouveau scan QR sera nécessaire pour se reconnecter.
 */
export const destroySession = async (userId) => {
  const sUserId = userId.toString();
  const session = sessions.get(sUserId);
  if (!session) return;

  try {
    await session.sock.logout();
  } catch {
    /* déjà déconnecté */
  }

  sessions.delete(sUserId);
  pendingInits.delete(sUserId);
  await WhatsAppAuth.deleteOne({ userId: sUserId });
  await log("info", "Session WhatsApp détruite", { userId: sUserId });
};

/**
 * Initialise les sessions de tous les utilisateurs actifs au démarrage du serveur.
 * Un délai de 1 s entre chaque init évite de saturer WhatsApp simultanément.
 */
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
