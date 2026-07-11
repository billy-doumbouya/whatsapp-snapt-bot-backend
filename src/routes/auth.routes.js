import { Router } from "express";
import { login, me, updateSettings } from "../controllers/auth.controller.js";
import { protect } from "../middleware/auth.middleware.js";
import { authLimiter } from "../middleware/rateLimiter.middleware.js";

const router = Router();

router.all("/login", (req, res, next) => {
  if (req.method === "POST") return next();

  return res.status(405).json({
    error: "Cette route attend une requête POST avec email et password.",
  });
});
router.post("/login", authLimiter, login);
router.get("/me", protect, me);
router.patch("/settings", protect, updateSettings);

export default router;