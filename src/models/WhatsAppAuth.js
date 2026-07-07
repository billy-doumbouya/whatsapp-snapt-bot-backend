import mongoose from "mongoose";

const whatsAppAuthSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    // creds et keys séparés : les IDs de clés Signal (ex: "221xxxx.0") contiennent
    // souvent des points, incompatibles comme noms de champs Mongo si non encodés.
    creds: { type: mongoose.Schema.Types.Mixed, default: {} },
    keys: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

export default mongoose.model("WhatsAppAuth", whatsAppAuthSchema);