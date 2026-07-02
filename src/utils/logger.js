import Log from "../models/Log.js";
import mongoose from "mongoose"; // Ajout de l'import mongoose pour vérifier l'état

export const log = async (
  type,
  message,
  { userId = null, postId = null, details = null } = {},
) => {
  // 1. On affiche TOUJOURS dans la console immédiatement (pour ne jamais rater un log au démarrage)
  const emoji =
    { info: "ℹ️", success: "✅", error: "❌", warn: "⚠️" }[type] || "•";
  console.log(`${emoji} [${type.toUpperCase()}] ${message}`);

  try {
    // 2. On n'enregistre en BDD QUE si MongoDB est pleinement connecté (readyState === 1)
    if (mongoose.connection.readyState === 1) {
      await Log.create({ type, message, userId, postId, details });
    } else {
      // Optionnel : un petit rappel en dev si la BDD n'est pas prête
      console.log(
        `📡 [LOGGER] Log non sauvegardé en BDD (Mongoose déconnecté)`,
      );
    }
  } catch (err) {
    console.error("Logger error (BDD):", err.message);
  }
};
