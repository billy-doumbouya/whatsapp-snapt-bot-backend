import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env.js";
import Message from "../models/Message.js";

const genAI = new GoogleGenerativeAI(env.geminiApiKey);
const HISTORY_LIMIT = 10;

// Ajout dans ai.service.js — adapte selon ton client Gemini existant

export const transcribeAudio = async (audioBuffer, mimeType) => {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const base64Audio = audioBuffer.toString("base64");

  const result = await model.generateContent([
    "Transcris fidèlement ce message vocal en texte, dans sa langue d'origine. Réponds uniquement avec la transcription, sans commentaire additionnel.",
    {
      inlineData: {
        mimeType,
        data: base64Audio,
      },
    },
  ]);

  return result.response.text().trim();
};

export const generateReply = async (user, contactId, incomingText) => {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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

  const prompt = `${systemPrompt}\n\nHistorique récent :\n${conversationText}\n\nClient : ${incomingText}\nAssistant :`;

  const result = await model.generateContent(prompt);
  return result.response.text().trim();
};

export const generateFullPost = async (user) => {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const theme = user.geminiThemes[user.themeIndex % user.geminiThemes.length];
  const prompt = `Génère un court texte inspirant pour un statut WhatsApp sur le thème : "${theme}". Maximum 200 caractères, avec 1 emoji pertinent.`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  return { text, theme, prompt };
};
