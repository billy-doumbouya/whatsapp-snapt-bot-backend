import { log } from "../utils/logger.js";

export const errorHandler = async (err, req, res, _next) => {
  await log("error", `Erreur non gérée : ${err.message}`, {
    details: err.stack,
    path: req.originalUrl,
  });
  res.status(err.status || 500).json({ error: err.message || "Erreur serveur interne" });
};