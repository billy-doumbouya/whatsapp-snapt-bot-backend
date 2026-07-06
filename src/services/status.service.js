import { getOrCreateSession } from "./baileys.service.js";
import { log } from "../utils/logger.js";

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout (${label}) après ${ms}ms`)), ms),
    ),
  ]);

/**
 * Publie un statut WhatsApp via Baileys.
 * ⚠️ Fonctionnalité "best effort" : WhatsApp a des mécanismes de filtrage anti-
 * automatisation connus sur les statuts (issues ouvertes non résolues côté
 * Baileys #2118, #2084). La requête peut réussir techniquement (200) sans que
 * le statut apparaisse réellement. Ne jamais présenter cette fonctionnalité
 * comme garantie à 100% auprès des clients.
 */
export const publishStatusViaBaileys = async (userId, { text, imageUrl }, io) => {
  const sUserId = userId.toString();
  const session = await getOrCreateSession(sUserId, io);

  if (session.status !== "connected") {
    throw new Error("Session WhatsApp non connectée");
  }

  const content = imageUrl
    ? { image: { url: imageUrl }, caption: text }
    : { text };

  await withTimeout(
    session.sock.sendMessage("status@broadcast", content, {
      broadcast: true,
      statusJidList: [],
    }),
    30_000,
    "publication statut",
  );

  await log("info", "Requête de publication de statut envoyée (best-effort, non garantie)", {
    userId: sUserId,
  });
};