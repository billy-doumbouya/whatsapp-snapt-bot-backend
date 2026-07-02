import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

async function connectMongoDB() {
  // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  if (
    mongoose.connection.readyState === 1 ||
    mongoose.connection.readyState === 2
  ) {
    return mongoose.connection;
  }

  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("MONGO_URI manquant dans les variables d'environnement");
  }

  // Configuration des écouteurs d'événements (une seule fois)
  if (mongoose.connection.listeners("connected").length === 0) {
    mongoose.connection.on("connected", () => {
      console.log("ℹ [MongoDB] Connecté ✓");
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️ [MongoDB] Déconnecté");
    });

    mongoose.connection.on("error", (err) => {
      console.error("❌ [MongoDB] Erreur :", err.message);
    });
  }

  try {
    mongoose.set("strictQuery", true);

    console.log("🔄 Tentative de connexion à MongoDB...");
    await mongoose.connect(uri, {
      dbName: process.env.MONGO_DB_NAME || "uba_whatsapp",
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    return mongoose.connection;
  } catch (error) {
    console.error(
      "❌ [MongoDB] Échec initial de la connexion :",
      error.message,
    );
    throw error;
  }
}

export const connectDB = async () => {
  try {
    await connectMongoDB();
  } catch (error) {
    console.error(
      "❌ [MongoDB] Échec de la connexion initiale :",
      error.message,
    );
    process.exit(1);
  }
};
