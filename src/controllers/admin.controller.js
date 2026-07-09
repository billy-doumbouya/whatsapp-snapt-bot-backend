import User from "../models/User.js";
import { generateTempPassword } from "../helpers/password.helper.js";
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

  const tempPassword = generateTempPassword(name);

  // Important : on passe le mot de passe EN CLAIR ici. Le hook pre("save")
  // du modèle User se charge du hachage (bcrypt) une seule fois.
  // Hacher manuellement ici en plus provoquait un double hachage qui
  // rendait le login impossible avec le mot de passe communiqué à l'utilisateur.
  const user = await User.create({
    name,
    email,
    businessName,
    password: tempPassword,
    role: "user",
  });

  try {
    await sendCredentialsEmail({ to: email, name, email, password: tempPassword });
  } catch (err) {
    await log("error", `Échec envoi email identifiants à ${email} : ${err.message}`, {
      userId: user._id,
    });
    // L'email a échoué mais le compte existe déjà (email unique en DB) —
    // on renvoie le mot de passe temporaire dans la réponse pour que
    // l'admin puisse le communiquer manuellement, sinon l'utilisateur
    // n'a AUCUN moyen de se connecter.
    return res.status(201).json({
      user: user.toSafeObject(),
      tempPassword,
      warning: "Utilisateur créé, mais l'email d'identifiants n'a pas pu être envoyé. Communiquez ce mot de passe manuellement.",
    });
  }

  await log("success", `Utilisateur créé : ${email}`, { userId: user._id });
  res.status(201).json({ user: user.toSafeObject() });
});

/**
 * Régénère un mot de passe temporaire et renvoie l'email d'identifiants.
 * Utile si l'envoi initial a échoué, ou si l'utilisateur a perdu son mot de passe.
 */
export const resendCredentials = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });

  const tempPassword = generateTempPassword(user.name);
  user.password = tempPassword; // le hook pre("save") hache au save()
  await user.save();

  try {
    await sendCredentialsEmail({
      to: user.email,
      name: user.name,
      email: user.email,
      password: tempPassword,
    });
  } catch (err) {
    await log("error", `Échec renvoi identifiants à ${user.email} : ${err.message}`, {
      userId: user._id,
    });
    return res.status(200).json({
      user: user.toSafeObject(),
      tempPassword,
      warning: "Mot de passe régénéré, mais l'email n'a pas pu être envoyé. Communiquez-le manuellement.",
    });
  }

  await log("success", `Identifiants renvoyés à ${user.email}`, { userId: user._id });
  res.json({ user: user.toSafeObject() });
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

export const toggleUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  user.isActive = !user.isActive;
  await user.save();
  res.json({ user: user.toSafeObject?.() || user });
});

export const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndDelete(req.params.id);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  res.json({ message: "Utilisateur supprimé" });
});