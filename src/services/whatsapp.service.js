import fs from "fs-extra";
import path from "path";
import { log } from "../utils/logger.js";
import {
  getOrCreateSession,
  getSessionStatus,
  destroySession,
} from "./baileys.service.js";

/**
 * Wrapper léger fournissant quelques utilitaires pour l'envoi via Baileys.
 * Ce fichier restaure une API simple que d'autres parties de l'app peuvent
 * consommer sans connaître les détails de Baileys.
 */

export const connect = async (userId, io) => {
  return getOrCreateSession(userId.toString(), io);
};

export const disconnect = async (userId) => {
  return destroySession(userId.toString());
};

export const getStatus = (userId) => {
  return getSessionStatus(userId.toString());
};

export const sendText = async (userId, toJid, text, io) => {
  const session = await getOrCreateSession(userId.toString(), io);
  if (!session || session.status !== "connected") {
    throw new Error("Session WhatsApp non connectée");
  }
  await session.sock.sendMessage(toJid, { text });
  await log("info", `Message texte envoyé à ${toJid}`, { userId });
};

export const sendMedia = async (userId, toJid, mediaBuffer, mimeType, caption = "", io) => {
  const session = await getOrCreateSession(userId.toString(), io);
  if (!session || session.status !== "connected") {
    throw new Error("Session WhatsApp non connectée");
  }

  const message = {};
  if (mimeType.startsWith("image/")) message.image = { mimetype: mimeType, caption };
  else if (mimeType.startsWith("video/")) message.video = { mimetype: mimeType, caption };
  else message.document = { mimetype: mimeType, fileName: "file" };

  // Baileys accepte Buffers directement
  const content = { ...message, [Object.keys(message)[0]]: { ...Object.values(message)[0], buffer: mediaBuffer } };

  await session.sock.sendMessage(toJid, content);
  await log("info", `Média envoyé à ${toJid}`, { userId });
};

export const saveBufferToTemp = async (buffer, name = "upload.bin") => {
  const tmpDir = path.resolve(process.cwd(), ".tmp");
  await fs.ensureDir(tmpDir);
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, buffer);
  return p;
};

export default {
  connect,
  disconnect,
  getStatus,
  sendText,
  sendMedia,
  saveBufferToTemp,
};
