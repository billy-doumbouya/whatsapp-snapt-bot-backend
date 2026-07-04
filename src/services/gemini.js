import { log } from "../utils/logger.js";
import { v2 as cloudinary } from "cloudinary"; // ← FIX: était commenté, causait un ReferenceError silencieux

const API_KEY = process.env.GEMINI_API_KEY;
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const FREE_TEXT_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3-flash-preview",
];

const IMAGE_MODELS = [
  "gemini-3.1-flash-image",
  "gemini-2.5-flash-image",
  "imagen-4.0-fast-generate-001",
];

const callGeminiWithFallback = async (models, endpoint, payload, userId) => {
  let lastErr;
  for (const model of models) {
    try {
      const url = `${BASE_URL}/${model}:${endpoint}?key=${API_KEY}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const err = new Error(
          `Status ${response.status}: ${errorData.error?.message || "Unknown error"}`,
        );
        err.status = response.status;
        throw err;
      }

      const data = await response.json();
      return { data, modelUsed: model };
    } catch (err) {
      lastErr = err;
      await log("warn", `Échec avec le modèle ${model}: ${err.message}`, {
        userId,
      });
      if (err.status && ![429, 500, 503].includes(err.status)) throw err;
    }
  }
  throw (
    lastErr ||
    new Error("Tous les modèles ont échoué ou ont atteint leur quota.")
  );
};

export const generateStatusText = async (user) => {
  const themes = user.geminiThemes;
  const theme = themes[user.themeIndex % themes.length];
  const prompt = user.geminiPromptTemplate.replace("{{theme}}", theme);

  const payload = { contents: [{ parts: [{ text: prompt }] }] };

  const { data, modelUsed } = await callGeminiWithFallback(
    FREE_TEXT_MODELS,
    "generateContent",
    payload,
    user._id.toString(),
  );

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

  await log("info", `Texte généré pour "${theme}" (via ${modelUsed})`, {
    userId: user._id,
  });
  return { text, theme, prompt };
};

export const generateStatusImage = async (theme, userId) => {
  try {
    const imagePrompt =
      `Create a vibrant, inspiring social media image for WhatsApp status about: "${theme}". ` +
      `Style: modern, colorful, motivational. No text overlay. 1:1 ratio.`;

    const payload = {
      contents: [{ role: "user", parts: [{ text: imagePrompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    };

    const { data, modelUsed } = await callGeminiWithFallback(
      IMAGE_MODELS,
      "generateContent",
      payload,
      userId,
    );

    const parts = data.candidates?.[0]?.content?.parts;
    const imagePart = parts?.find((p) => p.inlineData);

    if (!imagePart || !imagePart.inlineData) {
      throw new Error(
        "Aucune donnée d'image trouvée dans la réponse de " + modelUsed,
      );
    }

    const { mimeType, data: base64Data } = imagePart.inlineData;
    const dataUri = `data:${mimeType};base64,${base64Data}`;

    const uploaded = await cloudinary.uploader.upload(dataUri, {
      folder: `whatsapp-status/${userId}`,
      resource_type: "image",
    });

    await log(
      "success",
      `Image générée via ${modelUsed} (payant) et uploadée sur Cloudinary`,
      { userId },
    );
    return { imageUrl: uploaded.secure_url, imagePublicId: uploaded.public_id };
  } catch (err) {
    await log("warn", `Génération image échouée : ${err.message}`, { userId });
    return { imageUrl: null, imagePublicId: null };
  }
};

export const generateFullPost = async (user) => {
  const { text, theme, prompt } = await generateStatusText(user);

  let imageUrl = null;
  let imagePublicId = null;

  if (user.generateImage) {
    const img = await generateStatusImage(theme, user._id.toString());
    imageUrl = img.imageUrl;
    imagePublicId = img.imagePublicId;
  }

  return { text, theme, prompt, imageUrl, imagePublicId };
};
