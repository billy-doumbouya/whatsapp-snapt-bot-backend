import { sessions, getOrCreateSession } from "./baileys.service.js";
import Contact from "../models/Contact.js";
import { log } from "../utils/logger.js";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Télécharge une image distante (Cloudinary, etc.) et retourne un Buffer.
 * Nécessaire car Baileys ne résout pas les URLs directement pour les statuts.
 */
const fetchImageBuffer = async (url) => {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`Téléchargement image échoué (${res.status}) : ${url}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

/**
 * Attend que la session soit dans l'état "connected" avec un timeout.
 * Nécessaire car getOrCreateSession peut retourner une session encore en
 * cours d'initialisation (état "initializing" ou "qr_ready").
 */
const waitForConnected = (sUserId, timeoutMs = 10_000) =>
  new Promise((resolve, reject) => {
    const session = sessions.get(sUserId);

    // Déjà connecté → résolution immédiate
    if (session?.status === "connected") return resolve(session);

    // Pas de session du tout → rejet immédiat
    if (!session) return reject(new Error("Aucune session WhatsApp active"));

    // En attente de connexion → polling léger
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
          `Session non connectée après ${timeoutMs}ms (état actuel : ${s?.status ?? "absente"})`,
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
 * automatisation sur les statuts (issues Baileys #2118, #2084). La requête
 * peut techniquement réussir (pas d'erreur) sans que le statut apparaisse
 * pour tous les contacts. Ne jamais garantir un taux de diffusion à 100%.
 *
 * Pour maximiser la visibilité :
 * - Le compte doit avoir des contacts qui ont enregistré son numéro
 * - `statusJidList` doit contenir les JIDs de ces contacts
 * - Éviter les publications trop fréquentes (< 1/jour)
 *
 * @param {string} userId
 * @param {{ text: string, imageUrl?: string|null }} content
 * @param {import("socket.io").Server} io
 */
export const publishStatusViaBaileys = async (
  userId,
  { text, imageUrl },
  io,
) => {
  const sUserId = userId.toString();

  // 1. S'assurer que la session existe (la crée si absente)
  await getOrCreateSession(sUserId, io);

  // 2. Attendre que la connexion soit effective (gère le cold start)
  const session = await waitForConnected(sUserId);

  // 3. Récupérer les JIDs des contacts en base
  //    → Baileys en a besoin pour déterminer qui peut voir le statut.
  //    → Sans cette liste le statut est publié mais potentiellement invisible.
  const contacts = await Contact.find({ userId: sUserId })
    .select("waId")
    .lean();

  const statusJidList = contacts
    .map((c) => c.waId)
    .filter((jid) => jid && jid.endsWith("@s.whatsapp.net"));

  if (statusJidList.length === 0) {
    await log(
      "warn",
      "Aucun contact @s.whatsapp.net trouvé — le statut sera publié sans liste de diffusion (visibilité réduite)",
      { userId: sUserId },
    );
  }

  // 4. Construire le contenu du message
  let content;

  if (imageUrl) {
    const imageBuffer = await fetchImageBuffer(imageUrl);
    content = {
      image: imageBuffer,
      caption: text,
    };
  } else {
    content = { text };
  }

  // 5. Envoyer le statut
  await session.sock.sendMessage("status@broadcast", content, {
    backgroundColor: "#000000", // requis par certaines versions de WA pour les statuts texte
    statusJidList,
  });

  await log(
    "success",
    `Statut publié (best-effort) — ${statusJidList.length} contact(s) ciblé(s)`,
    { userId: sUserId },
  );
};
