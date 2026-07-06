import { Router } from "express";
import { listLogs } from "../controllers/logs.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = Router();

router.get("/", protect, listLogs);

export default router;