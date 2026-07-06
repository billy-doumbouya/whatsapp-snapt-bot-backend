import Contact from "../models/Contact.js";
import Message from "../models/Message.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const listContacts = asyncHandler(async (req, res) => {
  const contacts = await Contact.find({ userId: req.user._id }).sort({
    lastInteractionAt: -1,
  });
  res.json({ contacts });
});

export const getMessages = asyncHandler(async (req, res) => {
  const { contactId } = req.params;
  const contact = await Contact.findOne({ _id: contactId, userId: req.user._id });
  if (!contact) return res.status(404).json({ error: "Contact introuvable" });

  const messages = await Message.find({ contactId }).sort({ createdAt: 1 });
  res.json({ contact, messages });
});