import { env } from "../config/env.js";
import Message from "../models/Message.js";

const HISTORY_LIMIT = 10;

// Modèles Gemini gratuits, du plus capable au plus basique (fallback en cascade).
// Les modèles Pro sont payants uniquement depuis avril 2026, donc exclus ici.
const FREE_MODELS = [
  "gemini-2.5-flash",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-flash-lite",
];

const GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

/** 429 = quota épuisé, 500/503 = modèle temporairement indisponible : on bascule sur le suivant */
const isRetryableStatus = (status) =>
  status === 429 || status === 503 || status === 500;

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
    const err = new Error(
      `Gemini (${model}) a répondu ${res.status} : ${errText}`,
    );
    err.status = res.status;
    err.retryable = isRetryableStatus(res.status);
    throw err;
  }

  const data = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ||
    "";
  return text.trim();
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

export const generateReply = async (user, contactId, incomingText) => {
  const history = await Message.find({ contactId })
    .sort({ createdAt: -1 })
    .limit(HISTORY_LIMIT)
    .lean();

  const systemPrompt = user.assistantPrompt.replace(
    "{{businessName}}",
    user.businessName || "notre entreprise",
  );

  const conversationText = history
    .reverse()
    .map((m) => `${m.direction === "in" ? "Client" : "Assistant"} : ${m.text}`)
    .join("\n");

  const prompt = `Historique récent :\n${conversationText}\n\nClient : ${incomingText}\nAssistant :`;

  return generateWithFallback({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });
};

export const generateFullPost = async (user) => {
  const theme = user.geminiThemes[user.themeIndex % user.geminiThemes.length];
  const prompt = `Génère un court texte inspirant pour un statut WhatsApp sur le thème : "${theme}". Maximum 200 caractères, avec 1 emoji pertinent.`;

  const text = await generateWithFallback({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  return { text, theme, prompt };
};
