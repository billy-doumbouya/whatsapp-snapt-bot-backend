import {
  getOrCreateSession,
  getSessionStatus,
  destroySession,
} from "../services/baileys.service.js";
import User from "../models/User.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const getStatus = asyncHandler(async (req, res) => {
  const { status, qr } = getSessionStatus(req.user._id.toString());
  res.json({ status, qr, botEnabled: req.user.botEnabled });
});

export const connect = asyncHandler(async (req, res) => {
  const io = req.app.get("io");
  await getOrCreateSession(req.user._id.toString(), io);

  // Attendre que le QR soit généré et disponible (couvre un cold start Baileys
  // sur VPS peu réactif). Timeout élargi pour ne pas rater un handshake lent,
  // sans bloquer indéfiniment la requête HTTP.
  const start = Date.now();
  let qr = null;
  let status = null;
  while (Date.now() - start < 8000) {
    const s = getSessionStatus(req.user._id.toString());
    status = s.status;
    qr = s.qr;
    if (qr || status === "connected") break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  res.json({ message: "Connexion WhatsApp initialisée", status, qr });
});

export const disconnect = asyncHandler(async (req, res) => {
  await destroySession(req.user._id.toString());
  res.json({ message: "WhatsApp déconnecté" });
});

/** Bascule manuelle depuis le dashboard (équivalent du "stop"/"start" WhatsApp) */
export const toggleBot = asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  const user = await User.findByIdAndUpdate(
    req.user._id,
    { botEnabled: !!enabled },
    { new: true },
  ).select("-password");
  req.app.get("io")?.to(`user:${req.user._id}`).emit("bot:status", {
    botEnabled: user.botEnabled,
  });
  res.json({ botEnabled: user.botEnabled });
});

export const updatePrompt = asyncHandler(async (req, res) => {
  const { assistantPrompt } = req.body;
  if (!assistantPrompt) {
    return res.status(400).json({ error: "assistantPrompt requis" });
  }
  const user = await User.findByIdAndUpdate(
    req.user._id,
    { assistantPrompt },
    { new: true },
  ).select("-password");
  res.json({ user });
});
