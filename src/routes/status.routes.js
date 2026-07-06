import { Router } from "express";
import {
  listPosts,
  generatePost,
  updatePost,
  publishPost,
  deletePost,
} from "../controllers/status.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = Router();
router.use(protect);

router.get("/", listPosts);
router.post("/generate", generatePost);
router.patch("/:id", updatePost);
router.post("/:id/publish", publishPost);
router.delete("/:id", deletePost);

export default router;