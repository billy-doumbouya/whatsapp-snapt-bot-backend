import Post from "../models/Post.js";
import User from "../models/User.js";
import { manualGenerate, forcePublish } from "../services/scheduler.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const listPosts = asyncHandler(async (req, res) => {
  const posts = await Post.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(50);
  res.json({ posts });
});

export const generatePost = asyncHandler(async (req, res) => {
  // 1. Appel du service de génération
  const post = await manualGenerate(req.user._id.toString());

  // 2. 🛡️ SÉCURITÉ & INCRÉMENTATION DU THEME INDEX (Point 2)
  // On récupère l'utilisateur pour incrémenter son index de thème avec un Modulo
  const user = await User.findById(req.user._id);
  if (user && user.geminiThemes && user.geminiThemes.length > 0) {
    // Le modulo % permet de revenir à 0 automatiquement dès qu'on dépasse le nombre maximal de thèmes
    const nextIndex = (user.themeIndex + 1) % user.geminiThemes.length;

    await User.findByIdAndUpdate(req.user._id, {
      $set: { themeIndex: nextIndex },
    });
  }

  res.status(201).json({ post });
});

export const updatePost = asyncHandler(async (req, res) => {
  const post = await Post.findOne({ _id: req.params.id, userId: req.user._id });
  if (!post) return res.status(404).json({ error: "Post introuvable" });

  // 3. 🛡️ VALIDATION DES INPUTS (Point 3)
  // Limite stricte sur le texte du statut WhatsApp (max 1000 caractères par sécurité/coûts)
  if (req.body.text !== undefined) {
    const textTrimmed = req.body.text.trim();
    if (textTrimmed.length > 1000) {
      return res
        .status(400)
        .json({
          error: "Le texte du statut ne peut pas dépasser 1000 caractères.",
        });
    }
    post.text = textTrimmed;
  }

  if (req.body.imageUrl !== undefined) {
    post.imageUrl = req.body.imageUrl;
  }

  if (req.body.scheduledAt !== undefined) {
    const scheduleDate = new Date(req.body.scheduledAt);
    if (isNaN(scheduleDate.getTime()) || scheduleDate < new Date()) {
      return res
        .status(400)
        .json({
          error:
            "La date de planification doit être une date valide et future.",
        });
    }
    post.scheduledAt = scheduleDate;
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
  const post = await Post.findOneAndDelete({
    _id: req.params.id,
    userId: req.user._id,
  });
  if (!post) return res.status(404).json({ error: "Post introuvable" });
  res.json({ message: "Post supprimé" });
});
