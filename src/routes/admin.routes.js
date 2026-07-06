import { Router } from "express";
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
} from "../controllers/admin.controller.js";
import { adminOnly, protect } from "../middleware/auth.middleware.js";

const router = Router();

router.use(protect, adminOnly);

router.get("/users", listUsers);
router.post("/users", createUser);
router.patch("/users/:id", updateUser);
router.delete("/users/:id", deleteUser);

export default router;