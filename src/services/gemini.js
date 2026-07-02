import { log } from "../utils/logger.js";
// Assure-toi d'importer cloudinary si ce n'est pas déjà fait globalement
// import { v2 as cloudinary } from 'cloudinary';

const API_KEY = process.env.GEMINI_API_KEY;
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

// Liste des modèles gratuits utilisables pour le texte (par ordre de préférence)
const FREE_TEXT_MODELS = [
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
];

/**
 * Fonction utilitaire pour appeler l'API Gemini avec gestion de fallback
 */
const callGeminiWithFallback = async (models, endpoint, payload, userId) => {
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
        throw new Error(
          `Status ${response.status}: ${errorData.error?.message || "Unknown error"}`,
        );
      }

      const data = await response.json();
      // On retourne le résultat ainsi que le modèle qui a fonctionné
      return { data, modelUsed: model };
    } catch (err) {
      await log("warn", `Échec avec le modèle ${model}: ${err.message}`, {
        userId,
      });
      // La boucle continue vers le modèle suivant
    }
  }
  throw new Error(
    "Tous les modèles gratuits ont échoué ou ont atteint leur quota.",
  );
};

/**
 * Génère un texte de statut WhatsApp via Gemini (API REST)
 */
export const generateStatusText = async (user) => {
  const themes = user.geminiThemes;
  const theme = themes[user.themeIndex % themes.length];
  const prompt = user.geminiPromptTemplate.replace("{{theme}}", theme);

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
  };

  // Appel avec la boucle de secours
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

/**
 * Génère une image via Gemini Imagen (API REST) et l'uploade sur Cloudinary
 * Note : Imagen 3 (imagen-3.0-generate-002) est généralement le modèle standard actuel.
 */
export const generateStatusImage = async (theme, userId) => {
  try {
    const imagePrompt =
      `Create a vibrant, inspiring social media image for WhatsApp status about: "${theme}". ` +
      `Style: modern, colorful, motivational. No text overlay. 1:1 ratio.`;

    const payload = {
      contents: [{ role: "user", parts: [{ text: imagePrompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    };

    // Pour l'image, on tente le modèle 2.0 en premier, sinon le modèle imagen standard
    const imageModels = [
      "gemini-2.0-flash-preview-image-generation",
      "imagen-3.0-generate-002",
    ];

    const { data, modelUsed } = await callGeminiWithFallback(
      imageModels,
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
      `Image générée via ${modelUsed} et uploadée sur Cloudinary`,
      { userId },
    );
    return { imageUrl: uploaded.secure_url, imagePublicId: uploaded.public_id };
  } catch (err) {
    await log("warn", `Génération image échouée : ${err.message}`, { userId });
    return { imageUrl: null, imagePublicId: null };
  }
};

/**
 * Génère texte + image pour un utilisateur
 */
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
