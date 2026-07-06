import statusRoutes from "./status.routes.js";
import { Router } from "express";
import authRoutes from "./auth.routes.js";
import adminRoutes from "./admin.routes.js";
import whatsappRoutes from "./whatsapp.routes.js";
import conversationRoutes from "./conversation.routes.js";
import logsRoutes from "./logs.routes.js";

const router = Router();

router.use("/auth", authRoutes);
router.use("/admin", adminRoutes);
router.use("/whatsapp", whatsappRoutes);
router.use("/conversation", conversationRoutes);
router.use("/logs", logsRoutes);

router.use("/status", statusRoutes);
export default router;
