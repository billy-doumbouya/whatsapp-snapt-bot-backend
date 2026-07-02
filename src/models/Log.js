import mongoose from "mongoose";

const logSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    type: {
      type: String,
      enum: ["info", "success", "error", "warn"],
      default: "info",
    },
    message: { type: String, required: true },
    details: { type: mongoose.Schema.Types.Mixed, default: null },
    postId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      default: null,
    },
  },
  { timestamps: true },
);

logSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model("Log", logSchema);
