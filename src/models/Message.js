import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      required: true,
    },
    direction: { type: String, enum: ["in", "out"], required: true },
    text: { type: String, required: true },
  },
  { timestamps: true },
);

messageSchema.index({ userId: 1, contactId: 1, createdAt: 1 });

export default mongoose.model("Message", messageSchema);
