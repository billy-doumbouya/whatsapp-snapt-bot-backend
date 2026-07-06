import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env.js";
import Message from "../models/Message.js";

const genAI = new GoogleGenerativeAI(env.geminiApiKey);
const HISTORY_LIMIT = 10;

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