import mongoose from "mongoose";

const whatsAppAuthSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    creds: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

export default mongoose.model("WhatsAppAuth", whatsAppAuthSchema);
