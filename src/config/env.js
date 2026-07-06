import "dotenv/config";

const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Variable d'environnement manquante : ${key}`);
  return value;
};

export const env = {
  port: process.env.PORT || 3001,
  mongoUri: required("MONGO_URI"),
  jwtSecret: required("JWT_SECRET"),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
  geminiApiKey: required("GEMINI_API_KEY"),
  waDataPath: process.env.WWEBJS_DATA_PATH || "./.baileys_auth",
  smtp: {
    host: required("SMTP_HOST"),
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    user: required("SMTP_USER"),
    pass: required("SMTP_PASS"),
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
  },
};