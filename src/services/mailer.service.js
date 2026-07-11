import { transporter } from "../config/mailer.js";
import { env } from "../config/env.js";
import { log } from "../utils/logger.js";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Échappe les caractères HTML spéciaux pour éviter toute injection dans le template. */
const escapeHtml = (str) =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

// ─────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────

const buildCredentialsHtml = ({ name, email, password, appUrl }) => `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * { box-sizing: border-box; }
    @media only screen and (max-width: 480px) {
      .wrapper   { padding: 20px 10px !important; }
      .container { padding: 24px 16px !important; border-radius: 16px !important; }
      .cred-td   { display: block !important; width: 100% !important; text-align: left !important; padding: 10px 12px !important; }
      .cred-label-td { border-bottom: none !important; padding-bottom: 0 !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;width:100% !important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div class="wrapper" style="background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 50%,#311042 100%);padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;min-height:100%;">
    <div class="container" style="max-width:460px;width:100%;margin:0 auto;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:24px;padding:32px;box-shadow:0 20px 40px rgba(0,0,0,0.3);text-align:center;word-wrap:break-word;word-break:break-word;">

      <!-- Logo -->
      <div style="margin-bottom:24px;">
        <span style="background:linear-gradient(90deg,#818cf8,#c084fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-weight:800;font-size:22px;letter-spacing:-0.5px;">
          StatusBot
        </span>
      </div>

      <!-- Titre -->
      <h2 style="color:#ffffff;font-size:20px;font-weight:700;margin:0 0 12px;letter-spacing:-0.5px;">
        Bienvenue, ${escapeHtml(name)}&nbsp;!
      </h2>
      <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 28px;">
        Votre compte a été configuré avec succès.<br />Voici vos accès confidentiels :
      </p>

      <!-- Credentials -->
      <table style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;margin-bottom:28px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;">
        <tr>
          <td class="cred-td cred-label-td" style="padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.08);text-align:left;color:#94a3b8;font-size:13px;font-weight:500;width:35%;word-break:break-all;">
            Email
          </td>
          <td class="cred-td" style="padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.08);text-align:right;color:#ffffff;font-size:14px;font-weight:600;font-family:monospace;word-break:break-all;">
            ${escapeHtml(email)}
          </td>
        </tr>
        <tr>
          <td class="cred-td cred-label-td" style="padding:14px 16px;text-align:left;color:#94a3b8;font-size:13px;font-weight:500;width:35%;">
            Mot de passe
          </td>
          <td class="cred-td" style="padding:14px 16px;text-align:right;color:#38bdf8;font-size:14px;font-weight:600;font-family:monospace;letter-spacing:0.5px;word-break:break-all;">
            ${escapeHtml(password)}
          </td>
        </tr>
      </table>

      <!-- CTA -->
      <div style="margin-bottom:28px;">
        <a href="${escapeHtml(appUrl)}" target="_blank" rel="noopener noreferrer"
           style="display:inline-block;max-width:100%;background:#ffffff;color:#0f172a;font-weight:600;font-size:14px;padding:12px 28px;border-radius:12px;text-decoration:none;box-shadow:0 4px 12px rgba(255,255,255,0.15);">
          Accéder au tableau de bord →
        </a>
      </div>

      <hr style="border:0;border-top:1px solid rgba(255,255,255,0.08);margin:0 0 20px;" />

      <!-- Avertissement sécurité -->
      <p style="color:#64748b;font-size:12px;line-height:1.5;margin:0;">
        💡 <strong style="color:#94a3b8;">Conseil de sécurité :</strong>
        Modifiez ce mot de passe temporaire dès votre première connexion depuis vos paramètres.
      </p>

    </div>
  </div>
</body>
</html>
`;

const buildCredentialsText = ({ name, email, password, appUrl }) =>
  `
Bienvenue, ${name} !

Votre compte StatusBot a été configuré avec succès.

──────────────────────
Email        : ${email}
Mot de passe : ${password}
──────────────────────

Accéder au tableau de bord : ${appUrl}

Conseil de sécurité : modifiez ce mot de passe temporaire dès votre première
connexion depuis Paramètres → Changer le mot de passe.
`.trim();

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

/**
 * Envoie les identifiants de connexion à un nouvel utilisateur.
 *
 * @param {{ to: string, name: string, email: string, password: string }} params
 */
export const sendCredentialsEmail = async ({ to, name, email, password }) => {
  const appUrl = env.PUBLIC_APP_URL;

  await transporter.sendMail({
    from: env.smtp.from,
    replyTo: env.smtp.user,
    to,
    subject: "Vos identifiants de connexion — StatusBot",
    text: buildCredentialsText({ name, email, password, appUrl }),
    html: buildCredentialsHtml({ name, email, password, appUrl }),
    headers: {
      "X-Entity-Ref-ID": `credentials-${Date.now()}`,
    },
  });

  await log("success", `Email d'identifiants envoyé à ${to}`);
};
