import { transporter } from "../config/mailer.js";
import { env } from "../config/env.js";
import { log } from "../utils/logger.js";

export const sendCredentialsEmail = async ({ to, name, email, password }) => {
  const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        /* Styles de secours universels pour limiter l'overflow */
        * { box-sizing: border-box; }
        @media only screen and (max-width: 480px) {
          .wrapper { padding: 20px 10px !important; }
          .container { padding: 24px 16px !important; border-radius: 16px !important; }
          .credentials-table td { display: block !important; width: 100% !important; text-align: left !important; padding: 10px 12px !important; }
          .credentials-table tr td:first-child { border-bottom: none !important; padding-bottom: 0 !important; }
        }
      </style>
    </head>
    <body style="margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
      <div class="wrapper" style="background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #311042 100%); padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; min-height: 100%;">
        <div class="container" style="max-width: 460px; width: 100%; margin: 0 auto; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 24px; padding: 32px; box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3); text-align: center; word-wrap: break-word; word-break: break-word;">
          
          <div style="margin-bottom: 24px;">
            <span style="background: linear-gradient(90deg, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-weight: 800; font-size: 22px; letter-spacing: -0.5px;">StatusBot</span>
          </div>

          <h2 style="color: #ffffff; font-size: 20px; font-weight: 700; margin: 0 0 12px 0; letter-spacing: -0.5px;">Bienvenue, ${name} !</h2>
          <p style="color: #94a3b8; font-size: 14px; line-height: 1.5; margin: 0 0 28px 0;">Votre compte SaaS a été configuré avec succès. Voici vos accès confidentiels :</p>
          
          <table class="credentials-table" style="width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 0; margin-bottom: 28px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; overflow: hidden;">
            <tr>
              <td style="padding: 14px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); text-align: left; color: #94a3b8; font-size: 13px; font-weight: 500; width: 30%; word-wrap: break-word; word-break: break-all;">Email</td>
              <td style="padding: 14px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); text-align: right; color: #ffffff; font-size: 14px; font-weight: 600; font-family: monospace; word-wrap: break-word; word-break: break-all;">${email}</td>
            </tr>
            <tr>
              <td style="padding: 14px 16px; text-align: left; color: #94a3b8; font-size: 13px; font-weight: 500; width: 30%;">Mot de passe</td>
              <td style="padding: 14px 16px; text-align: right; color: #38bdf8; font-size: 14px; font-weight: 600; font-family: monospace; letter-spacing: 0.5px; word-wrap: break-word; word-break: break-all;">${password}</td>
            </tr>
          </table>

          <div style="margin-bottom: 28px;">
            <a href="${env.frontendUrl}" target="_blank" style="display: inline-block; max-width: 100%; background: #ffffff; color: #0f172a; font-weight: 600; font-size: 14px; padding: 12px 24px; border-radius: 12px; text-decoration: none; box-shadow: 0 4px 12px rgba(255,255,255,0.15); word-wrap: break-word; word-break: break-word;">
              Accéder au Tableau de Bord
            </a>
          </div>

          <hr style="border: 0; border-top: 1px solid rgba(255, 255, 255, 0.08); margin: 0 0 20px 0;" />
          
          <p style="color: #64748b; font-size: 12px; line-height: 1.4; margin: 0;">
            💡 <strong>Conseil de sécurité :</strong> Nous vous invitons instamment à modifier ce mot de passe temporaire dès votre première connexion depuis vos paramètres.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  const text = `Bienvenue, ${name} !

Votre compte SaaS a ete configure avec succes. Voici vos acces :

Email : ${email}
Mot de passe : ${password}

Acceder au tableau de bord : ${env.frontendUrl}

Conseil de securite : nous vous invitons instamment a modifier ce mot de passe temporaire des votre premiere connexion depuis vos parametres.`;

  await transporter.sendMail({
    from: env.smtp.from,
    replyTo: env.smtp.user,
    to,
    subject: "Vos identifiants de connexion StatusBot",
    text,
    html,
    headers: {
      "X-Entity-Ref-ID": `credentials-${Date.now()}`,
    },
  });

  await log("success", `Email d'identifiants envoyé à ${to}`);
};
