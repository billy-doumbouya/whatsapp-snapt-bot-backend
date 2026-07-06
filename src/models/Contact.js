import mongoose from "mongoose";

const contactSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    waId: { type: String, required: true }, // ex: "224xxxxxxxxx@s.whatsapp.net"
    name: { type: String, default: "" },
    lastInteractionAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

contactSchema.index({ userId: 1, waId: 1 }, { unique: true });

export default mongoose.model("Contact", contactSchema);