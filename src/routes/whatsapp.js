import { Router } from "express";
import {
  destroyClient,
  getClientStatus,
  getOrCreateClient,
} from "../services/whatsapp.js";
import { protect } from "../middleware/auth.js";

const router = Router();

// GET /api/whatsapp/status — statut de connexion WA du user
router.get("/status", protect, (req, res) => {
  const userId = req.user._id.toString();
  const { status, qr } = getClientStatus(userId);
  res.json({ status, qr });
});

// POST /api/whatsapp/connect — initialise/reconnecte le client WA
router.post("/connect", protect, async (req, res) => {
  try {
    const userId = req.user._id.toString();
    const io = req.app.get("io");
    await getOrCreateClient(userId, io);
    res.json({ message: "Connexion WhatsApp initialisée" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/whatsapp/disconnect
router.post("/disconnect", protect, async (req, res) => {
  try {
    const userId = req.user._id.toString();
    await destroyClient(userId);
    res.json({ message: "WhatsApp déconnecté" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
