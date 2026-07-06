import Log from "../models/Log.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const listLogs = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const filter = req.user.role === "admin" ? {} : { userId: req.user._id };
  const logs = await Log.find(filter).sort({ createdAt: -1 }).limit(limit);
  res.json({ logs });
});