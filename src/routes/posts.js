import { Router } from "express";
import { protect } from "../middleware/auth.js";
import Post from "../models/Post.js";
import { forcePublish, manualGenerate } from "../services/scheduler.js";
import cloudinary from "../config/cloudinary.js";

const router = Router();

// GET /api/posts — posts du user connecté (ou tous si admin avec ?all=true)
router.get("/", protect, async (req, res) => {
  try {
    const filter = req.query.all === "true" && req.user.role === "admin"
      ? {}
      : { userId: req.user._id };

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [posts, total] = await Promise.all([
      Post.find(filter)
        .populate("userId", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Post.countDocuments(filter),
    ]);

    res.json({ posts, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/posts/today — post du jour
router.get("/today", protect, async (req, res) => {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const post = await Post.findOne({
      userId: req.user._id,
      scheduledAt: { $gte: start, $lte: end },
    }).sort({ createdAt: -1 });

    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/posts/generate — générer un post manuellement
router.post("/generate", protect, async (req, res) => {
  try {
    const post = await manualGenerate(req.user._id.toString());
    res.status(201).json({ post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/posts/:id — modifier texte/image/scheduledAt (override manuel)
router.patch("/:id", protect, async (req, res) => {
  try {
    const post = await Post.findOne({ _id: req.params.id, userId: req.user._id });
    if (!post) return res.status(404).json({ error: "Post introuvable" });

    const allowed = ["text", "imageUrl", "scheduledAt", "status"];
    for (const key of allowed) {
      if (req.body[key] !== undefined) post[key] = req.body[key];
    }
    post.isManual = true;
    await post.save();
    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/posts/:id/publish — forcer la publication immédiate
router.post("/:id/publish", protect, async (req, res) => {
  try {
    const post = await forcePublish(req.params.id, req.user._id.toString());
    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/posts/:id
router.delete("/:id", protect, async (req, res) => {
  try {
    const post = await Post.findOne({ _id: req.params.id, userId: req.user._id });
    if (!post) return res.status(404).json({ error: "Post introuvable" });

    // Supprimer l'image Cloudinary si elle existe
    if (post.imagePublicId) {
      await cloudinary.uploader.destroy(post.imagePublicId);
    }

    await post.deleteOne();
    res.json({ message: "Post supprimé" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
