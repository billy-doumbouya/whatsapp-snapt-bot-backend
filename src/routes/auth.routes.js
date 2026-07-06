import { Router } from "express";
import { login, me } from "../controllers/auth.controller.js";
import { protect } from "../middleware/auth.middleware.js";
import { authLimiter } from "../middleware/rateLimiter.middleware.js";

const router = Router();

router.post("/login", authLimiter, login);
router.get("/me", protect, me);

export default router;