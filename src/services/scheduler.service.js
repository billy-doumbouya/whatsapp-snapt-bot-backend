import cron from "node-cron";
import Post from "../models/Post.js";
import User from "../models/User.js";
import { publishStatusViaBaileys } from "./status.service.js";
import { generateFullPost } from "./ai.service.js";
import { log } from "../utils/logger.js";

const randomScheduleToday = (hourMin, hourMax) => {
  const now = new Date();
  const hour = Math.floor(Math.random() * (hourMax - hourMin + 1)) + hourMin;
  const minute = Math.floor(Math.random() * 60);
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target;
};

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

    user.themeIndex = (user.themeIndex + 1) % user.geminiThemes.length;
    await user.save();

    await log(
      "success",
      `Post généré et schedulé pour ${scheduledAt.toLocaleTimeString("fr-FR")}`,
      {
        userId: user._id,
      },
    );
  } catch (err) {
    await log("error", `Génération échouée : ${err.message}`, {
      userId: user._id,
    });
  }
};

const publishDuePosts = async (io) => {
  const now = new Date();
  const posts = await Post.find({
    status: "scheduled",
    scheduledAt: { $lte: now },
  }).populate("userId");

  for (const post of posts) {
    const user = post.userId;
    if (!user?.isActive || !user?.statusFeatureEnabled) continue;

    post.status = "publishing";
    await post.save();

    try {
      await publishStatusViaBaileys(
        user._id.toString(),
        { text: post.text, imageUrl: post.imageUrl },
        io,
      );

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

export const startScheduler = (io) => {
  cron.schedule("0 6 * * *", async () => {
    const users = await User.find({
      isActive: true,
      statusFeatureEnabled: true,
    });
    for (const user of users) await generateDraftForUser(user);
  });

  cron.schedule("*/5 * * * *", async () => {
    await publishDuePosts(io);
  });

  console.log("⏰ Scheduler statut démarré");
};

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

  user.themeIndex = (user.themeIndex + 1) % user.geminiThemes.length;
  await user.save();

  return post;
};

export const forcePublish = async (postId, userId, io) => {
  const post = await Post.findOneAndUpdate(
    { _id: postId, userId, status: { $nin: ["published", "publishing"] } },
    { status: "publishing" },
    { returnDocument: "after" },
  );

  if (!post)
    throw new Error(
      "Post introuvable, déjà publié, ou publication déjà en cours",
    );

  try {
    await publishStatusViaBaileys(
      userId,
      { text: post.text, imageUrl: post.imageUrl },
      io,
    );
    post.status = "published";
    post.publishedAt = new Date();
    await post.save();
    return post;
  } catch (err) {
    post.status = "failed";
    post.errorMessage = err.message;
    await post.save();
    throw err;
  }
};
