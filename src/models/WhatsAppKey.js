import mongoose from "mongoose";

const whatsAppKeySchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    category: { type: String, required: true },
    keyId: { type: String, required: true }, // encodé base64url
    value: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);

whatsAppKeySchema.index({ userId: 1, category: 1, keyId: 1 }, { unique: true });

export default mongoose.model("WhatsAppKey", whatsAppKeySchema);
