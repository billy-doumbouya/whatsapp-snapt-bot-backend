
// ─────────────────────────────────────────────
// Ajoute ce helper dans la section "Helpers" de baileys.service.js
// ─────────────────────────────────────────────

const HUMAN_DELAY_MIN_MS = 2_000;
const HUMAN_DELAY_MAX_MS = 6_000;

/**
 * Simule un délai de frappe humain aléatoire entre 2 et 6 secondes.
 * Réduit le risque de détection bot par WhatsApp avant chaque envoi.
 */
export  const humanDelay = () => {
  const ms =
    Math.floor(Math.random() * (HUMAN_DELAY_MAX_MS - HUMAN_DELAY_MIN_MS + 1)) +
    HUMAN_DELAY_MIN_MS;
  return new Promise((r) => setTimeout(r, ms));
};
