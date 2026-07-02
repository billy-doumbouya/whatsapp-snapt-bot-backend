import { Router } from "express";
import jwt from "jsonwebtoken";
import { adminOnly, protect } from "../middleware/auth.js";
import User from "../models/User.js";

const router = Router();

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

// POST /api/auth/register (admin uniquement)
router.post("/register", protect, adminOnly, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ error: "Nom, email et mot de passe requis" });
    }
    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ error: "Email déjà utilisé" });

    const user = await User.create({
      name,
      email,
      password,
      role: role || "user",
    });
    res.status(201).json({ user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email et mot de passe requis" });
    }
    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: "Email ou mot de passe incorrect" });
    }
    if (!user.isActive) {
      return res.status(403).json({ error: "Compte désactivé" });
    }
    const token = signToken(user._id);
    res.json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get("/me", protect, (req, res) => {
  res.json({ user: req.user.toSafeObject() });
});

// PATCH /api/auth/settings — mise à jour des paramètres du compte
router.patch("/settings", protect, async (req, res) => {
  try {
    const allowed = [
      "name",
      "geminiPromptTemplate",
      "geminiThemes",
      "publishHourMin",
      "publishHourMax",
      "autoGenerate",
      "generateImage",
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const user = await User.findByIdAndUpdate(req.user._id, updates, {
      new: true,
    }).select("-password");
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/auth/password
router.patch("/password", protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id);
    if (!(await user.comparePassword(currentPassword))) {
      return res.status(401).json({ error: "Mot de passe actuel incorrect" });
    }
    user.password = newPassword;
    await user.save();
    res.json({ message: "Mot de passe mis à jour" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
