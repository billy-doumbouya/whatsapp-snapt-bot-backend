import rateLimit from "express-rate-limit";

// 1. Protection globale de l'API (Basé sur l'IP)
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Légèrement augmenté pour éviter les faux positifs en prod
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Trop de requêtes globales, veuillez réessayer plus tard.",
  },
});

// 2. Protection contre le brute-force de l'authentification (Basé sur l'IP)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      "Trop de tentatives de connexion, compte bloqué temporairement (15 min).",
  },
});

// 3. 🛡️ NOUVEAU : Rate-limiting ciblé par UTILISATEUR pour la génération IA (Point 6)
// Protège ton portefeuille contre les abus de requêtes Gemini
export const iaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // Fenêtre de 1 heure
  max: 15, // Max 15 générations de statuts/prompts par heure et par utilisateur
  standardHeaders: true,
  legacyHeaders: false,

  // ⚡ L'astuce magique : On ne limite plus par IP, mais par l'ID de l'utilisateur connecté
  keyGenerator: (req) => {
    // Si l'utilisateur est authentifié par ton middleware d'auth, on utilise son ID unique
    if (req.user && req.user._id) {
      return req.user._id.toString();
    }
    // Fallback sur l'IP si la route n'est pas protégée (par sécurité)
    return req.ip;
  },

  handler: (req, res) => {
    res.status(429).json({
      error:
        "Quota horaire de génération IA atteint pour votre compte (Max 15 par heure). Veuillez patienter.",
    });
  },
});
