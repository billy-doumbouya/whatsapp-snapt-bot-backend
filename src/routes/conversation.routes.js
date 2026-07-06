import { Router } from "express";
import { listContacts, getMessages } from "../controllers/conversation.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = Router();

router.use(protect);

router.get("/contacts", listContacts);
router.get("/contacts/:contactId/messages", getMessages);

export default router;