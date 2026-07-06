import bcrypt from "bcryptjs";
import crypto from "crypto";

export const hashPassword = async (plain) => bcrypt.hash(plain, 10);

export const comparePassword = async (plain, hash) =>
  bcrypt.compare(plain, hash);

/** Génère un mot de passe temporaire lisible (ex: "Kx7-Trqm-42") pour l'email d'accueil */
export const generateTempPassword = () => {
  const raw = crypto
    .randomBytes(6)
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${Math.floor(10 + Math.random() * 89)}`;
};
