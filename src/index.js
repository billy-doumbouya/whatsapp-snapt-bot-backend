import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { connectDB } from "./config/db.js";
import authRoutes from "./routes/auth.js";
import postsRoutes from "./routes/posts.js";
import whatsappRoutes from "./routes/whatsapp.js";
import adminRoutes from "./routes/admin.js";
import logsRoutes from "./routes/logs.js";

import User from "./models/User.js";
import { initAllClients } from "./services/whatsapp.js";
import { startScheduler } from "./services/scheduler.js";
import { log } from "./utils/logger.js";

const app = express();
const httpServer = createServer(app);

// --- Configuration des Origines CORS (Express & Socket.io) ---
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(",").map((url) =>
      url.trim().replace(/\/$/, ""),
    )
  : ["http://localhost:5173"];

// Middleware CORS pour Express
app.use(
  cors({
    origin: function (origin, callback) {
      // Permet les requêtes sans origine (comme Postman ou les tâches planifiées)
      if (!origin) return callback(null, true);

      const sanitizedOrigin = origin.replace(/\/$/, "");

      if (allowedOrigins.indexOf(sanitizedOrigin) !== -1) {
        callback(null, true);
      } else {
        console.log(`[CORS Bloqué] Origine Express non autorisée : ${origin}`);
        callback(new Error("Non autorisé par les CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// --- Configuration Socket.io ---
// Socket.io accepte nativement un tableau de chaînes pour les origines !
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.set("io", io);

io.on("connection", (socket) => {
  socket.on("join", (userId) => {
    socket.join(`user:${userId}`);
  });
  socket.on("leave", (userId) => {
    socket.leave(`user:${userId}`);
  });
});

// --- Middlewares ---
// app.use(helmet()); // Désactivé pour le moment si nécessaire

app.use(express.json({ limit: "10mb" }));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// --- Routes ---
app.get("/", (_, res) => res.json({ message: "API WhatsApp Bot" }));
app.get("/health", (_, res) => res.json({ status: "ok", ts: new Date() }));
app.use("/api/auth", authRoutes);
app.use("/api/posts", postsRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/logs", logsRoutes);

// 404
app.use((_, res) => res.status(404).json({ error: "Route introuvable" }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Erreur serveur interne" });
});

// --- Démarrage ---
const bootstrap = async () => {
  await connectDB();

  // Créer le premier admin si aucun user n'existe
  const count = await User.countDocuments();
  if (count === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    await User.create({
      name: "Admin",
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
      role: "admin",
    });
    await log("success", `Admin créé : ${process.env.ADMIN_EMAIL}`);
  }

  // Initialiser les clients WA des users actifs
  const users = await User.find({ isActive: true });
  await initAllClients(users, io);

  // Démarrer le scheduler
  startScheduler();

  const PORT = process.env.PORT || 3001;
  httpServer.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  });
};

bootstrap();
