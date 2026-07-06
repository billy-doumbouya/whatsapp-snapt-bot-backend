import mongoose from "mongoose";

const postSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true },
    imageUrl: { type: String, default: null },
    prompt: { type: String },
    theme: { type: String },
    status: {
      type: String,
      enum: ["draft", "scheduled", "publishing", "published", "failed"],
      default: "draft",
    },
    scheduledAt: { type: Date },
    publishedAt: { type: Date, default: null },
    isManual: { type: Boolean, default: false },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true },
);

postSchema.index({ userId: 1, scheduledAt: 1, status: 1 });

export default mongoose.model("Post", postSchema);