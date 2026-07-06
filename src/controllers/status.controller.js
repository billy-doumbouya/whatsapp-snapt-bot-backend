import Post from "../models/Post.js";
import { manualGenerate, forcePublish } from "../services/scheduler.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const listPosts = asyncHandler(async (req, res) => {
  const posts = await Post.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50);
  res.json({ posts });
});

export const generatePost = asyncHandler(async (req, res) => {
  const post = await manualGenerate(req.user._id.toString());
  res.status(201).json({ post });
});

export const updatePost = asyncHandler(async (req, res) => {
  const post = await Post.findOne({ _id: req.params.id, userId: req.user._id });
  if (!post) return res.status(404).json({ error: "Post introuvable" });

  const allowed = ["text", "imageUrl", "scheduledAt"];
  for (const key of allowed) {
    if (req.body[key] !== undefined) post[key] = req.body[key];
  }
  post.isManual = true;
  if (post.status === "draft") post.status = "scheduled";
  await post.save();

  res.json({ post });
});

export const publishPost = asyncHandler(async (req, res) => {
  const io = req.app.get("io");
  const post = await forcePublish(req.params.id, req.user._id.toString(), io);
  res.json({ post });
});

export const deletePost = asyncHandler(async (req, res) => {
  const post = await Post.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
  if (!post) return res.status(404).json({ error: "Post introuvable" });
  res.json({ message: "Post supprimé" });
});