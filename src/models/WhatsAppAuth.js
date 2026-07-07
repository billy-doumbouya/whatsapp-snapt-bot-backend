import mongoose from "mongoose";

const whatsAppAuthSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

export default mongoose.model("WhatsAppAuth", whatsAppAuthSchema);