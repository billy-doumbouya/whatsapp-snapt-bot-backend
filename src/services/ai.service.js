import { env } from "../config/env.js";
import Message from "../models/Message.js";

// ─────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────

const HISTORY_LIMIT = 10;

/**
 * Modèles Gemini gratuits, du plus capable au plus basique.
 * Fallback en cascade si quota épuisé ou modèle indisponible.
 */
const FREE_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
];

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const isRetryableStatus = (status) =>
  status === 429 || status === 500 || status === 503;

// ─────────────────────────────────────────────
// Helpers Gemini
// ─────────────────────────────────────────────

const callGemini = async (model, body) => {
  const res = await fetch(`${GEMINI_BASE_URL}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.geminiApiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error(`Gemini (${model}) → ${res.status} : ${errText}`);
    err.status = res.status;
    err.retryable = isRetryableStatus(res.status);
    throw err;
  }

  const data = await res.json();
  return (
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || ""
  ).trim();
};

const generateWithFallback = async (body) => {
  let lastError;
  for (const model of FREE_MODELS) {
    try {
      return await callGemini(model, body);
    } catch (err) {
      lastError = err;
      if (!err.retryable) throw err;
    }
  }
  throw lastError;
};

// ─────────────────────────────────────────────
// Construction du system prompt
// ─────────────────────────────────────────────

/**
 * Construit le system prompt selon la relation avec le contact.
 *
 * Niveaux de relation :
 * - "wife"    → ton chaleureux, personnel, jamais commercial
 * - "friend"  → ton détendu et amical, pas de langue de bois
 * - "family"  → ton familial et bienveillant
 * - "vip"     → ton professionnel mais avec attention particulière
 * - null      → ton professionnel standard (client par défaut)
 */
const buildSystemPrompt = (user, contact, businessMode = false) => {
  const businessName = user.businessName || "notre entreprise";
  const base = (user.assistantPrompt || "Tu es l'assistant de {{businessName}}. Réponds de façon concise, professionnelle et utile.")
    .replace("{{businessName}}", businessName);

  const name = contact.name?.trim();
  const relationship = contact.relationship;

  // ── Relation personnelle : épouse ──
  if (relationship === "wife") {
    return `${base}

CONTEXTE IMPORTANT : Tu parles avec l'épouse du propriétaire de ce compte WhatsApp, pas avec une cliente.
Ton attitude :
- Ton chaleureux, intime et complice — comme un proche, pas un assistant
- Jamais commercial, jamais formel
- Appelle-la ${name ? `"${name}"` : "par son prénom"} naturellement
- Si elle parle de choses du quotidien, réponds normalement à la conversation
- Seul cas où tu mentionnes le business : si elle te le demande explicitement`;
  }

  // ── Relation personnelle : ami ──
  if (relationship === "friend") {
    return `${base}

CONTEXTE IMPORTANT : Tu parles avec un ami du propriétaire, pas un client.
Ton attitude :
- Ton détendu, amical et direct
- Pas de langue de bois, pas de formules commerciales
- Réponds normalement à la conversation si c'est un échange personnel
- Mentionne le business uniquement si la conversation l'amène naturellement${name ? `\n- Son prénom : ${name}` : ""}`;
  }

  // ── Relation personnelle : famille ──
  if (relationship === "family") {
    return `${base}

CONTEXTE IMPORTANT : Tu parles avec un membre de la famille du propriétaire.
Ton attitude :
- Ton bienveillant, familier et chaleureux
- Pas de ton commercial ou formel${name ? `\n- Appelle-le/la ${name} si le contexte s'y prête` : ""}`;
  }

  // ── Client VIP ──
  if (relationship === "vip") {
    return `${base}

CONTEXTE : Client VIP — traite cette conversation avec une attention et une réactivité particulières.${name ? `\nSon nom : ${name}. Utilise-le naturellement (accueil, conclusion) sans le répéter à chaque message.` : ""}`;
  }

  // ── Client standard (par défaut) ──
  if (!relationship) {
    if (businessMode) {
      if (name) {
        return `${base}

Le client s'appelle ${name}. Reste professionnel et adresse-toi à lui/elle par son prénom uniquement aux moments clés (accueil, remerciement, conclusion) — sans le répéter à chaque message pour rester naturel.`;
      }
      return base;
    }

    const friendlyBase = (user.assistantFriendlyPrompt || `Tu es un assistant amical pour ${businessName}. Réponds de façon chaleureuse, humaine et conversationnelle, sans ton commercial.`).replace("{{businessName}}", businessName);
    if (name) {
      return `${friendlyBase}

Le client s'appelle ${name}. Reste naturel et chaleureux, mentionne son prénom seulement aux moments clés.`;
    }
    return friendlyBase;
  }

  return base;
};

// Simple détection d'intention business à partir du texte
const BUSINESS_KEYWORDS = [
  "prix",
  "tarif",
  "devis",
  "commande",
  "acheter",
  "vente",
  "contrat",
  "facture",
  "service",
  "rdv",
  "rendez",
  "disponible",
  "produit",
  "coût",
  "payer",
  "paiement",
  "livraison",
  "budget",
];

const isBusinessIntent = (text) => {
  if (!text) return false;
  const t = text.toLowerCase();
  return BUSINESS_KEYWORDS.some((k) => t.includes(k));
};

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

/**
 * Transcrit un message vocal en texte via Gemini.
 */
export const transcribeAudio = async (audioBuffer, mimeType) => {
  const base64Audio = audioBuffer.toString("base64");
  return generateWithFallback({
    contents: [
      {
        role: "user",
        parts: [
          {
            text: "Transcris fidèlement ce message vocal en texte, dans sa langue d'origine. Réponds uniquement avec la transcription, sans commentaire additionnel.",
          },
          { inlineData: { mimeType, data: base64Audio } },
        ],
      },
    ],
  });
};

/**
 * Génère une réponse IA pour un message client entrant.
 * Adapte le ton selon la relation (wife, friend, family, vip, client).
 */
export const generateReply = async (user, contact, incomingText) => {
  const history = await Message.find({ contactId: contact._id })
    .sort({ createdAt: -1 })
    .limit(HISTORY_LIMIT)
    .lean();

  const conversationText = history
    .reverse()
    .map((m) => `${m.direction === "in" ? "Contact" : "Assistant"} : ${m.text}`)
    .join("\n");

  const combined = `${conversationText}\n${incomingText}`;
  const businessMode = isBusinessIntent(combined);
  const systemPrompt = buildSystemPrompt(user, contact, businessMode);

  const prompt = `Historique récent :\n${conversationText}\n\nContact : ${incomingText}\nAssistant :`;

  return generateWithFallback({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });
};

/**
 * Génère le texte du statut WhatsApp du jour via Gemini.
 */
export const generateFullPost = async (user) => {
  const themes = user.geminiThemes;
  const theme = themes?.[user.themeIndex % (themes?.length || 1)] || "Motivation";

  const prompt = `Génère un court texte inspirant pour un statut WhatsApp sur le thème : "${theme}". Maximum 200 caractères, avec 1 emoji pertinent. Réponds uniquement avec le texte, sans guillemets ni commentaire.`;

  const text = await generateWithFallback({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  return { text, theme, prompt };
};