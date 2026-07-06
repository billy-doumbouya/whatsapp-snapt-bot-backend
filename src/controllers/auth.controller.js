import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { comparePassword } from "../helpers/password.helper.js";
import { assertRequiredFields } from "../helpers/validators.helper.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { env } from "../config/env.js";
import { log } from "../utils/logger.js";

const signToken = (user) =>
  jwt.sign({ id: user._id, role: user.role }, env.jwtSecret, { expiresIn: "7d" });

export const login = asyncHandler(async (req, res) => {
  assertRequiredFields(req.body, ["email", "password"]);
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user || !(await comparePassword(password, user.password))) {
    return res.status(401).json({ error: "Email ou mot de passe incorrect" });
  }
  if (!user.isActive) {
    return res.status(403).json({ error: "Compte désactivé" });
  }

  const token = signToken(user);
  await log("info", `Connexion : ${user.email}`, { userId: user._id });

  res.json({
    token,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      botEnabled: user.botEnabled,
    },
  });
});

export const me = asyncHandler(async (req, res) => {
  res.json({ user: req.user });
});

export const updateSettings = asyncHandler(async (req, res) => {
  const allowed = [
    "geminiPromptTemplate",
    "publishHourMin",
    "publishHourMax",
    "autoGenerate",
    "generateImage",
    "geminiThemes",
    "assistantPrompt",
    "businessName",
    "botEnabled",
    "statusFeatureEnabled",
  ];

  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (updates.publishHourMin !== undefined && updates.publishHourMax !== undefined) {
    if (updates.publishHourMin >= updates.publishHourMax) {
      return res.status(400).json({ error: "L'heure min doit être inférieure à l'heure max" });
    }
  }

  const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true }).select(
    "-password",
  );

  res.json({ user });
});