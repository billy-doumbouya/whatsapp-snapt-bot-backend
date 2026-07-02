import { Router } from "express";
import { protect } from "../middleware/auth.js";
import Log from "../models/Log.js";

const router = Router();

// GET /api/logs — logs du user connecté
router.get("/", protect, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      Log.find({ userId: req.user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Log.countDocuments({ userId: req.user._id }),
    ]);

    res.json({ logs, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
