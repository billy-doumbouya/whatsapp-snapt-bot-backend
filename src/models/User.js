import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, required: true },
    role: { type: String, enum: ["admin", "user"], default: "user" },
    isActive: { type: Boolean, default: true },
    // Paramètres Gemini propres à chaque user
    geminiPromptTemplate: {
      type: String,
      default:
        "Tu es un expert en communication digitale. Génère un texte court et percutant (max 200 caractères) pour un statut WhatsApp sur le thème : {{theme}}. Le texte doit être inspirant, en français, et se terminer par un emoji pertinent.",
    },
    geminiThemes: {
      type: [String],
      default: [
        "Motivation du matin",
        "Développement personnel",
        "Innovation et technologie",
        "Leadership",
        "Entrepreneuriat en Afrique",
        "Éducation numérique",
        "Impact social",
        "Résilience",
        "Vision et objectifs",
        "Communauté et solidarité",
      ],
    },

    statusFeatureEnabled: { type: Boolean, default: false }, // best-effort, désactivé par défaut
    publishHourMin: { type: Number, default: 8 },
    publishHourMax: { type: Number, default: 20 },
    geminiThemes: {
      type: [String],
      default: ["Motivation", "Conseil du jour"],
    },
    themeIndex: { type: Number, default: 0 },
    themeIndex: { type: Number, default: 0 },
    publishHourMin: { type: Number, default: 9 },
    publishHourMax: { type: Number, default: 21 },
    autoGenerate: { type: Boolean, default: true },
    generateImage: { type: Boolean, default: true },
  },

  { timestamps: true },
);

// ✅ Corrigé : Utilisation de la syntaxe async moderne sans "next"
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;

  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

export default mongoose.model("User", userSchema);
