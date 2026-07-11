import cron from "node-cron";
import Post from "../models/Post.js";
import User from "../models/User.js";
import { publishStatusViaBaileys } from "./status.service.js";
import { generateFullPost } from "./ai.service.js";
import { log } from "../utils/logger.js";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Génère une heure de publication aléatoire dans la plage [hourMin, hourMax]
 * pour aujourd'hui. Si l'heure calculée est déjà passée, reporte à demain.
 */
const randomScheduleToday = (hourMin, hourMax) => {
  const min = Math.min(hourMin, hourMax);
  const max = Math.max(hourMin, hourMax);

  const hour = Math.floor(Math.random() * (max - min + 1)) + min;
  const minute = Math.floor(Math.random() * 60);

  const target = new Date();
  target.setHours(hour, minute, 0, 0);

  if (target <= new Date()) target.setDate(target.getDate() + 1);

  return target;
};

/**
 * Retourne le post du jour d'un utilisateur s'il existe déjà
 * (draft, scheduled, publishing ou published).
 */
const findTodayPost = (userId) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  return Post.findOne({
    userId,
    scheduledAt: { $gte: startOfDay, $lte: endOfDay },
    status: { $in: ["draft", "scheduled", "publishing", "published"] },
  });
};

/**
 * Incrémente l'index du thème pour un utilisateur de façon circulaire.
 * Protège contre un tableau vide.
 */
const advanceThemeIndex = async (user) => {
  const total = user.geminiThemes?.length || 0;
  user.themeIndex = total > 0 ? (user.themeIndex + 1) % total : 0;
  await user.save();
};

// ─────────────────────────────────────────────
// Génération
// ─────────────────────────────────────────────

/**
 * Génère et planifie le post du jour pour un utilisateur.
 * Ne fait rien si un post existe déjà pour aujourd'hui.
 */
const generateDraftForUser = async (user) => {
  const existing = await findTodayPost(user._id);
  if (existing) return;

  try {
    const { text, theme, prompt } = await generateFullPost(user);
    const scheduledAt = randomScheduleToday(
      user.publishHourMin,
      user.publishHourMax,
    );

    await Post.create({
      userId: user._id,
      text,
      theme,
      prompt,
      status: "scheduled",
      scheduledAt,
    });

    await advanceThemeIndex(user);

    await log(
      "success",
      `Post généré et planifié à ${scheduledAt.toLocaleTimeString("fr-FR")}`,
      { userId: user._id },
    );
  } catch (err) {
    await log("error", `Génération auto échouée : ${err.message}`, {
      userId: user._id,
    });
  }
};

// ─────────────────────────────────────────────
// Publication automatique
// ─────────────────────────────────────────────

/**
 * Publie tous les posts dont l'heure planifiée est arrivée.
 * Utilise le statut "publishing" comme verrou optimiste pour éviter
 * les doubles publications en cas de crons concurrents.
 */
const publishDuePosts = async (io) => {
  const now = new Date();

  const posts = await Post.find({
    status: "scheduled",
    scheduledAt: { $lte: now },
  }).populate("userId");

  for (const post of posts) {
    const user = post.userId;

    // Vérifications de sécurité avant publication
    if (!user?.isActive) continue;
    if (!user?.statusFeatureEnabled) continue;

    // Verrou optimiste : passe en "publishing" avant d'envoyer
    // pour éviter qu'un autre cron traite le même post simultanément
    post.status = "publishing";
    await post.save();

    try {
      await publishStatusViaBaileys(
        user._id.toString(),
        { text: post.text, imageUrl: post.imageUrl ?? null },
        io,
      );

      post.status = "published";
      post.publishedAt = new Date();
      post.errorMessage = null;
      await post.save();

      await log("success", `Statut publié pour ${user.email}`, {
        userId: user._id,
        postId: post._id,
      });
    } catch (err) {
      post.status = "failed";
      post.errorMessage = err.message;
      await post.save();

      await log(
        "error",
        `Publication échouée pour ${user.email} : ${err.message}`,
        {
          userId: user._id,
          postId: post._id,
        },
      );
    }
  }
};

// ─────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────

/**
 * Démarre les deux crons :
 * - 06h00 : génération automatique des posts du jour
 * - toutes les 5 min : publication des posts dont l'heure est arrivée
 */
export const startScheduler = (io) => {
  // Génération quotidienne à 06h00
  cron.schedule("0 6 * * *", async () => {
    await log("info", "⏰ Génération quotidienne déclenchée");
    const users = await User.find({
      isActive: true,
      statusFeatureEnabled: true,
      autoGenerate: true,
    });
    for (const user of users) {
      await generateDraftForUser(user);
    }
  });

  // Publication toutes les 5 minutes
  cron.schedule("*/5 * * * *", async () => {
    await publishDuePosts(io);
  });

  console.log(
    "⏰ Scheduler démarré (génération 06h00 / publication toutes les 5 min)",
  );
};

/**
 * Génère manuellement le post du jour depuis le dashboard.
 * Retourne le post existant s'il y en a déjà un pour aujourd'hui.
 */
export const manualGenerate = async (userId) => {
  const user = await User.findById(userId);
  if (!user) throw new Error("Utilisateur introuvable");

  const existing = await findTodayPost(user._id);
  if (existing) return existing;

  const { text, theme, prompt } = await generateFullPost(user);
  const scheduledAt = randomScheduleToday(
    user.publishHourMin,
    user.publishHourMax,
  );

  const post = await Post.create({
    userId: user._id,
    text,
    theme,
    prompt,
    status: "scheduled",
    scheduledAt,
    isManual: true,
  });

  await advanceThemeIndex(user);

  return post;
};

/**
 * Force la publication immédiate d'un post depuis le dashboard.
 * Utilise une mise à jour atomique pour éviter les doubles publications.
 *
 * @param {string} postId
 * @param {string} userId
 * @param {import("socket.io").Server} io
 */
export const forcePublish = async (postId, userId, io) => {
  // Mise à jour atomique : passe en "publishing" uniquement si le post
  // n'est pas déjà publié ou en cours de publication
  const post = await Post.findOneAndUpdate(
    { _id: postId, userId, status: { $nin: ["published", "publishing"] } },
    { status: "publishing" },
    { new: true },
  );

  if (!post) {
    throw new Error(
      "Post introuvable, déjà publié, ou publication déjà en cours",
    );
  }

  try {
    await publishStatusViaBaileys(
      userId.toString(),
      { text: post.text, imageUrl: post.imageUrl ?? null },
      io,
    );

    post.status = "published";
    post.publishedAt = new Date();
    post.errorMessage = null;
    await post.save();

    await log("success", "Publication forcée depuis le dashboard", {
      userId,
      postId: post._id,
    });

    return post;
  } catch (err) {
    post.status = "failed";
    post.errorMessage = err.message;
    await post.save();
    throw err;
  }
};
