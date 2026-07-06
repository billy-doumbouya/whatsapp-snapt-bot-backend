import User from "../models/User.js";
import { hashPassword, generateTempPassword } from "../helpers/password.helper.js";
import { assertRequiredFields, isValidEmail } from "../helpers/validators.helper.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendCredentialsEmail } from "../services/mailer.service.js";
import { log } from "../utils/logger.js";

export const listUsers = asyncHandler(async (req, res) => {
  const users = await User.find().select("-password").sort({ createdAt: -1 });
  res.json({ users });
});

export const createUser = asyncHandler(async (req, res) => {
  assertRequiredFields(req.body, ["name", "email", "businessName"]);
  const { name, email, businessName } = req.body;

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Email invalide" });
  }

  const existing = await User.findOne({ email });
  if (existing) {
    return res.status(409).json({ error: "Un compte existe déjà avec cet email" });
  }

  const tempPassword = generateTempPassword();
  const hashed = await hashPassword(tempPassword);

  const user = await User.create({
    name,
    email,
    businessName,
    password: hashed,
    role: "client",
  });

  try {
    await sendCredentialsEmail({ to: email, name, email, password: tempPassword });
  } catch (err) {
    await log("error", `Échec envoi email identifiants à ${email} : ${err.message}`, {
      userId: user._id,
    });
    // On ne bloque pas la création si l'email échoue, mais on prévient l'admin
    return res.status(201).json({
      user,
      warning: "Utilisateur créé, mais l'email d'identifiants n'a pas pu être envoyé.",
    });
  }

  await log("success", `Utilisateur créé : ${email}`, { userId: user._id });
  res.status(201).json({ user });
});

export const updateUser = asyncHandler(async (req, res) => {
  const allowed = ["name", "businessName", "isActive", "assistantPrompt"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const user = await User.findByIdAndUpdate(req.params.id, updates, {
    new: true,
  }).select("-password");

  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  res.json({ user });
});

export const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndDelete(req.params.id);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  res.json({ message: "Utilisateur supprimé" });
});