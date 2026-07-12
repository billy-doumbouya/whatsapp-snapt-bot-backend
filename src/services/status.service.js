import { sessions, getOrCreateSession } from "./baileys.service.js";
import Contact from "../models/Contact.js";
import { log } from "../utils/logger.js";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Télécharge une image distante et retourne un Buffer.
 * Nécessaire car Baileys ne résout pas les URLs pour les statuts.
 */
const fetchImageBuffer = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Téléchargement image échoué (${res.status}) : ${url}`);
  return Buffer.from(await res.arrayBuffer());
};

/**
 * Attend que la session soit connectée avec un timeout.
 * Gère le cas où la session est encore en initialisation au moment de l'appel.
 */
const waitForConnected = (sUserId, timeoutMs = 15_000) =>
  new Promise((resolve, reject) => {
    const session = sessions.get(sUserId);

    if (session?.status === "connected") return resolve(session);
    if (!session) return reject(new Error("Aucune session WhatsApp active"));

    const interval = setInterval(() => {
      const s = sessions.get(sUserId);
      if (!s) {
        clearInterval(interval);
        clearTimeout(timer);
        return reject(new Error("Session WhatsApp perdue pendant l'attente"));
      }
      if (s.status === "connected") {
        clearInterval(interval);
        clearTimeout(timer);
        return resolve(s);
      }
    }, 300);

    const timer = setTimeout(() => {
      clearInterval(interval);
      const s = sessions.get(sUserId);
      reject(
        new Error(
          `Session non connectée après ${timeoutMs}ms (état : ${s?.status ?? "absente"})`,
        ),
      );
    }, timeoutMs);
  });

// ─────────────────────────────────────────────
// Publication
// ─────────────────────────────────────────────

/**
 * Publie un statut WhatsApp via Baileys.
 *
 * ⚠️  Fonctionnalité "best-effort" : WhatsApp applique des filtres anti-
 * automatisation sur les statuts. La requête peut réussir sans que le statut
 * soit visible par tous les contacts.
 *
 * Note sur les formats JID :
 * WhatsApp migre progressivement vers les LID (@lid) qui remplacent les
 * numéros classiques (@s.whatsapp.net). Les deux formats sont acceptés
 * dans statusJidList depuis Baileys 6.x.
 */
export const publishStatusViaBaileys = async (userId, { text, imageUrl }, io) => {
  const sUserId = userId.toString();

  // 1. S'assurer que la session existe
  await getOrCreateSession(sUserId, io);

  // 2. Attendre que la connexion soit effective
  const session = await waitForConnected(sUserId);

  // 3. Récupérer tous les contacts — accepter @s.whatsapp.net ET @lid
  const contacts = await Contact.find({ userId: sUserId }).select("waId").lean();

  const statusJidList = contacts
    .map((c) => c.waId?.trim())
    .filter((jid) => jid && (
      jid.endsWith("@s.whatsapp.net") ||
      jid.endsWith("@lid")
    ));

  if (statusJidList.length === 0) {
    await log(
      "warn",
      "Aucun contact valide trouvé — statut publié sans liste de diffusion (visibilité réduite)",
      { userId: sUserId },
    );
  }

  // 4. Construire le contenu
  let content;
  if (imageUrl) {
    const imageBuffer = await fetchImageBuffer(imageUrl);
    content = { image: imageBuffer, caption: text };
  } else {
    content = {
      text,
      backgroundColor: "#075E54",
      font: 0,
    };
  }

  // 5. Envoyer
  await session.sock.sendMessage("status@broadcast", content, {
    statusJidList,
  });

  await log(
    "success",
    `Statut publié — ${statusJidList.length} contact(s) ciblé(s)`,
    { userId: sUserId },
  );
};