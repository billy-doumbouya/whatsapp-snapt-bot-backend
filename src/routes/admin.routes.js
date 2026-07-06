import { Router } from "express";
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  toggleUser,
} from "../controllers/admin.controller.js";
import { adminOnly, protect } from "../middleware/auth.middleware.js";

const router = Router();

router.use(protect, adminOnly);

router.get("/users", listUsers);
router.post("/users", createUser);
router.patch("/users/:id", updateUser);
router.patch("/users/:id/toggle", toggleUser);
router.delete("/users/:id", deleteUser);

export default router;