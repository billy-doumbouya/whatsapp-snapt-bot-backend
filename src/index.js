import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";

import { env } from "./config/env.js";
import { connectDB } from "./config/db.js";
import routes from "./routes/index.js";
import { errorHandler } from "./middleware/errorHandler.middleware.js";
import { apiLimiter } from "./middleware/rateLimiter.middleware.js";

import User from "./models/User.js";
import { initAllSessions } from "./services/baileys.service.js";
import { hashPassword } from "./helpers/password.helper.js";
import { log } from "./utils/logger.js";

const app = express();
const httpServer = createServer(app);

const allowedOrigins = env.frontendUrl.split(",").map((u) => u.trim().replace(/\/$/, ""));

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
  await log("error", `Exception non gérée : ${err.message}`, { details: err.stack });
  process.exit(1);
});
process.on("unhandledRejection", async (reason) => {
  await log("error", `Rejet non géré : ${reason}`, { details: reason?.stack });
});

const bootstrap = async () => {
  await connectDB();

  const count = await User.countDocuments();
  if (count === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    await User.create({
      name: "Admin",
      email: process.env.ADMIN_EMAIL,
      password: await hashPassword(process.env.ADMIN_PASSWORD),
      role: "admin",
    });
    await log("success", `Admin créé : ${process.env.ADMIN_EMAIL}`);
  }

  const users = await User.find({ isActive: true, role: "client" });
  await initAllSessions(users, io);

  httpServer.listen(env.port, () => {
    console.log(`🚀 Serveur démarré sur le port ${env.port}`);
  });
};

bootstrap();