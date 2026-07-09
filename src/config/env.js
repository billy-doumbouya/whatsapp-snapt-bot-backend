import "dotenv/config";

const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Variable d'environnement manquante : ${key}`);
  return value;
};

// FRONTEND_URL peut contenir plusieurs origines séparées par des virgules
// (utile pour le CORS : localhost en dev + domaine Vercel en prod).
const frontendUrlsRaw = process.env.FRONTEND_URL || "http://localhost:5173";
const frontendUrls = frontendUrlsRaw
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

// Pour les liens envoyés par email, il faut UNE seule URL, jamais localhost.
// PUBLIC_APP_URL est prioritaire si définie ; sinon on prend la première
// URL non-localhost de la liste FRONTEND_URL.
const publicAppUrl =
  process.env.PUBLIC_APP_URL ||
  frontendUrls.find((u) => !u.includes("localhost")) ||
  frontendUrls[0];

export const env = {
  port: process.env.PORT || 3001,
  mongoUri: required("MONGO_URI"),
  jwtSecret: required("JWT_SECRET"),

  // Conservé pour compatibilité avec le code existant (ex: CORS actuel).
  frontendUrl: frontendUrlsRaw,

  // À utiliser pour le CORS : tableau d'origines autorisées.
  frontendUrls,

  // À utiliser pour tout lien affiché à un utilisateur (emails, etc.).
  publicAppUrl,

  geminiApiKey: required("GEMINI_API_KEY"),
  smtp: {
    host: required("SMTP_HOST"),
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    user: required("SMTP_USER"),
    pass: required("SMTP_PASS"),
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
  },
};
