import cron from "node-cron";
import Post from "../models/Post.js";
import { log } from "../utils/logger.js";
import { publishStatus } from "./whatsapp.js";
import User from "../models/User.js";
import { generateFullPost } from "./gemini.js";

const randomScheduleToday = (hourMin, hourMax) => {
  const now = new Date();
  const hour = Math.floor(Math.random() * (hourMax - hourMin + 1)) + hourMin;
  const minute = Math.floor(Math.random() * 60);
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target;
};

// Helper factorisé — utilisé par generateDraftForUser ET manualGenerate
const findTodayPost = async (userId) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  return Post.findOne({
    userId,
    scheduledAt: { $gte: startOfDay, $lte: endOfDay },
    status: { $in: ["draft", "scheduled"] },
  });
};

const generateDraftForUser = async (user) => {
  const existing = await findTodayPost(user._id);
  if (existing) return;

  try {
    const { text, theme, prompt, imageUrl, imagePublicId } =
      await generateFullPost(user);
    const scheduledAt = randomScheduleToday(
      user.publishHourMin,
      user.publishHourMax,
    );

    await Post.create({
      userId: user._id,
      text,
      theme,
      prompt,
      imageUrl,
      imagePublicId,
      status: "scheduled",
      scheduledAt,
    });

    user.themeIndex = (user.themeIndex + 1) % user.geminiThemes.length;
    await user.save();

    await log(
      "success",
      `Post généré et schedulé pour ${scheduledAt.toLocaleTimeString("fr-FR")}`,
      { userId: user._id },
    );
  } catch (err) {
    await log("error", `Génération échouée : ${err.message}`, {
      userId: user._id,
    });
  }
};

const publishDuePosts = async () => {
  const now = new Date();
  const posts = await Post.find({
    status: "scheduled",
    scheduledAt: { $lte: now },
  }).populate("userId");

  for (const post of posts) {
    const user = post.userId;
    if (!user?.isActive || !user?.autoGenerate) continue;

    try {
      await publishStatus(user._id.toString(), {
        text: post.text,
        imageUrl: post.imageUrl,
      });

      post.status = "published";
      post.publishedAt = new Date();
      await post.save();

      await log("success", `Statut publié pour ${user.email}`, {
        userId: user._id,
        postId: post._id,
      });
    } catch (err) {
      post.status = "failed";
      post.errorMessage = err.message;
      await post.save();

      await log("error", `Publication échouée : ${err.message}`, {
        userId: user._id,
        postId: post._id,
      });
    }
  }
};

export const startScheduler = () => {
  cron.schedule("0 6 * * *", async () => {
    await log("info", "⏰ Lancement génération quotidienne");
    const users = await User.find({ isActive: true, autoGenerate: true });
    for (const user of users) {
      await generateDraftForUser(user);
    }
  });

  cron.schedule("*/5 * * * *", async () => {
    await publishDuePosts();
  });

  console.log("⏰ Scheduler démarré");
};

/**
 * Génère manuellement un post pour un user (override depuis le dashboard)
 */
export const manualGenerate = async (userId) => {
  const user = await User.findById(userId);
  if (!user) throw new Error("Utilisateur introuvable");

  // FIX: anti-doublon — si un post existe déjà aujourd'hui, on le retourne au lieu d'en créer un nouveau
  const existing = await findTodayPost(user._id);
  if (existing) return existing;

  let text, theme, prompt, imageUrl, imagePublicId;

  try {
    const aiPost = await generateFullPost(user);
    text = aiPost.text;
    theme = aiPost.theme;
    prompt = aiPost.prompt;
    imageUrl = aiPost.imageUrl;
    imagePublicId = aiPost.imagePublicId;
  } catch (aiError) {
    console.error(
      "Gemini API Error, fallback sur un texte de secours:",
      aiError.message,
    );
    text =
      "Nouveau statut en cours de préparation... (L'IA a atteint son quota, écrivez votre texte ici !)";
    theme = user.geminiThemes[user.themeIndex] || "Général";
    prompt = "Fallback automatique";
  }

  const scheduledAt = randomScheduleToday(
    user.publishHourMin,
    user.publishHourMax,
  );

  const post = await Post.create({
    userId: user._id,
    text,
    theme,
    prompt,
    imageUrl,
    imagePublicId,
    status: "scheduled", // ← FIX: était "draft", invisible pour publishDuePosts
    scheduledAt,
    isManual: true,
  });

  user.themeIndex = (user.themeIndex + 1) % user.geminiThemes.length;
  await user.save();

  return post;
};

/**
 * Publie immédiatement un post (forcer depuis le dashboard)
 */
export const forcePublish = async (postId, userId) => {
  const post = await Post.findOne({ _id: postId, userId });
  if (!post) throw new Error("Post introuvable");

  await publishStatus(userId, { text: post.text, imageUrl: post.imageUrl });

  post.status = "published";
  post.publishedAt = new Date();
  await post.save();

  await log("success", "Publication forcée depuis le dashboard", {
    userId,
    postId: post._id,
  });

  return post;
};
