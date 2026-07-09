import bcrypt from "bcryptjs";

export const hashPassword = async (plain) => bcrypt.hash(plain, 10);
export const comparePassword = async (plain, hash) =>
  bcrypt.compare(plain, hash);

/**
 * Génère un mot de passe temporaire au format : Nom + année en cours + caractère spécial.
 * Ex: "Bill2026!" pour un utilisateur nommé "Bill Doumbouya".
 *
 * Note sécurité : ce format est volontairement simple à retenir/communiquer,
 * mais reste devinable si le nom est connu. Il doit impérativement être
 * changé par l'utilisateur dès sa première connexion (déjà recommandé
 * dans l'email de bienvenue).
 */
export const generateTempPassword = (name = "") => {
  const base =
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // retire les accents
      .split(/\s+/)[0] // garde seulement le premier prénom/mot
      .replace(/[^a-zA-Z]/g, "") || // garde uniquement des lettres
    "User";

  const formattedBase = base.charAt(0).toUpperCase() + base.slice(1);
  const year = new Date().getFullYear();

  const specials = "!@#$%&*";
  const special = specials[Math.floor(Math.random() * specials.length)];

  return `${formattedBase}${year}${special}`;
};
