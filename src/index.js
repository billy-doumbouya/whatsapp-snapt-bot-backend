import { startScheduler } from "./services/scheduler.service.js";
import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import mongoose from "mongoose";
import { env } from "./config/env.js";
import { connectDB } from "./config/db.js";
import routes from "./routes/index.js";
import { errorHandler } from "./middleware/errorHandler.middleware.js";
import { apiLimiter } from "./middleware/rateLimiter.middleware.js";
import User from "./models/User.js";
import { initAllSessions } from "./services/baileys.service.js";
import { log } from "./utils/logger.js";

const app = express();
const httpServer = createServer(app);

const allowedOrigins = env.frontendUrl
  .split(",")
  .map((u) => u.trim().replace(/\/$/, ""));

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ""))) {
        return callback(null, true);
      }
      callback(new Error("Non autorisé par les CORS"));
    },
    credentials: true,
  }),
);

const io = new Server(httpServer, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true },
});
app.set("io", io);

io.on("connection", (socket) => {
  socket.on("join", (userId) => socket.join(`user:${userId}`));
  socket.on("leave", (userId) => socket.leave(`user:${userId}`));
});

app.use(helmet());
app.use(express.json({ limit: "10mb" }));
app.use(apiLimiter);

app.get("/", (_, res) => res.json({ message: "API WhatsApp Assistant" }));
app.get("/health", (_, res) => res.json({ status: "ok", ts: new Date() }));
app.use("/api", routes);
app.use((_, res) => res.status(404).json({ error: "Route introuvable" }));
app.use(errorHandler);

process.on("uncaughtException", async (err) => {
  await log("error", `Exception non gérée : ${err.message}`, {
    details: err.stack,
  });
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  await log("error", `Rejet non géré : ${reason}`, { details: reason?.stack });
});

// ─── Arrêt propre : laisse le temps aux écritures Mongo en cours (creds/keys
// Baileys) de se terminer avant que Railway ne tue le process au déploiement ───
let isShuttingDown = false;
const gracefulShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  await log("warn", `Signal ${signal} reçu, arrêt propre en cours…`);
  io.close();
  httpServer.close();
  // Laisse un court délai pour que les écritures Mongo en cours
  // (creds.update / keys.set de Baileys) aient le temps de finir
  await new Promise((r) => setTimeout(r, 3000));
  try {
    await mongoose.connection.close();
  } catch {}
  await log("warn", "Arrêt propre terminé, process quitte maintenant.");
  process.exit(0);
};
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

const bootstrap = async () => {
  await connectDB();

  const count = await User.countDocuments();
  if (count === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    await User.create({
      name: "Admin",
      email: process.env.ADMIN_EMAIL,
      // En clair : le hook pre("save") du modèle User se charge du hachage.
      // Hacher ici en plus provoquait un double hachage rendant le login impossible.
      password: process.env.ADMIN_PASSWORD,
      role: "admin",
    });
    await log("success", `Admin créé : ${process.env.ADMIN_EMAIL}`);
  }

  const users = await User.find({
    isActive: true,
    $or: [{ role: "user" }, { role: "client" }],
  });
  await initAllSessions(users, io);
  startScheduler(io);

  httpServer.listen(env.port, () => {
    console.log(`🚀 Serveur démarré sur le port ${env.port}`);
  });
};

bootstrap();
