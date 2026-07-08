import { log } from "../utils/logger.js";

export const errorHandler = async (err, req, res, _next) => {
  const isProduction = process.env.NODE_ENV === "production";
  const statusCode = err.status || 500;

  // 1. 🪵 On log l'intégralité des détails en interne (très important pour le debug)
  await log("error", `Erreur survenue : ${err.message}`, {
    details: err.stack,
    path: req.originalUrl,
    method: req.method,
    userId: req.user?._id || "Non authentifié",
  });

  // 2. 🛡️ Sanitisation de la réponse client (Point 7)
  let clientMessage = err.message || "Erreur serveur interne";

  if (isProduction && statusCode === 500) {
    // En production, on masque le vrai message d'une erreur 500 pour éviter les fuites de sécurité
    clientMessage =
      "Une erreur interne est survenue. Veuillez contacter le support.";
  }

  // 3. Réponse propre et sécurisée
  res.status(statusCode).json({
    error: clientMessage,
    // On n'affiche la stack trace qu'en développement local pour le confort du dev
    ...(isProduction ? {} : { stack: err.stack }),
  });
};
