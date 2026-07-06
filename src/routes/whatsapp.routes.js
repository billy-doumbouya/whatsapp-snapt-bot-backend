import { Router } from "express";
import {
  getStatus,
  connect,
  disconnect,
  toggleBot,
  updatePrompt,
} from "../controllers/whatsapp.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = Router();

router.use(protect);

router.get("/status", getStatus);
router.post("/connect", connect);
router.post("/disconnect", disconnect);
router.post("/toggle", toggleBot);
router.patch("/prompt", updatePrompt);

export default router;