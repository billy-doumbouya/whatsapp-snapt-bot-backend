import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
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
import { generateReply } from "./ai.service.js";

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

/**
 * Traite un message entrant.
 * - Si c'est le propriétaire qui s'écrit "stop"/"start" à lui-même : bascule botEnabled
 * - Sinon, si botEnabled : génère une réponse IA et l'envoie
 */
const handleIncomingMessage = async (sUserId, session, msg, io) => {
  if (!msg.message) return;

  const remoteJid = msg.key.remoteJid;
  const isFromMe = msg.key.fromMe;
  const text =
    msg.message.conversation || msg.message.extendedTextMessage?.text || "";

  if (!text.trim()) return;

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
  pendingInits.delete(sUserId); // ← évite aussi de retourner une init fantôme en cours

  // Suppression garantie ici, sans dépendre du timing du handler connection.update
  await fs.remove(sessionPath(sUserId));
};
