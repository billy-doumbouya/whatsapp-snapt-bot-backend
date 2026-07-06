import { transporter } from "../config/mailer.js";
import { env } from "../config/env.js";
import { log } from "../utils/logger.js";

export const sendCredentialsEmail = async ({ to, name, email, password }) => {
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: auto;">
      <h2>Bienvenue sur StatusBot, ${name} !</h2>
      <p>Votre compte a été créé. Voici vos identifiants de connexion :</p>
      <table style="width:100%; border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding:8px; background:#f5f5f5;"><strong>Email</strong></td><td style="padding:8px;">${email}</td></tr>
        <tr><td style="padding:8px; background:#f5f5f5;"><strong>Mot de passe</strong></td><td style="padding:8px;">${password}</td></tr>
      </table>
      <p>Connectez-vous ici : <a href="${env.frontendUrl}">${env.frontendUrl}</a></p>
      <p style="color:#888; font-size:12px;">Nous vous recommandons de changer ce mot de passe après votre première connexion.</p>
    </div>
  `;

  await transporter.sendMail({
    from: env.smtp.from,
    to,
    subject: "Vos identifiants de connexion StatusBot",
    html,
  });

  await log("success", `Email d'identifiants envoyé à ${to}`);
};