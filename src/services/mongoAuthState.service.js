import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";
import WhatsAppAuth from "../models/WhatsAppAuth.js";
import WhatsAppKey from "../models/WhatsAppKey.js";
import { log } from "../utils/logger.js";

/**
 * MongoDB n'accepte pas bien les "." dans les noms de champs imbriqués.
 * Les IDs de clés Signal générés par Baileys contiennent souvent des points
 * (ex: "221xxxxxxxxx.0"). On les encode en base64url avant stockage.
 */
const encodeId = (id) =>
  Buffer.from(id, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const decodeId = (encoded) => {
  let b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Buffer.from(b64, "base64").toString("utf8");
};

export const useMongoAuthState = async (userId) => {
  // ─────────────────────────────────────────────
  // Étape 0 — Garantir l'existence du document creds AVANT toute écriture
  // concurrente. Élimine la race condition d'upsert simultané qui a produit
  // un creds vide lors du premier pairing.
  // ─────────────────────────────────────────────
  await WhatsAppAuth.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId, creds: null } },
    { upsert: true },
  );

  const existing = await WhatsAppAuth.findOne({ userId }).lean();

  // Un objet vide ({}) n'est PAS un creds valide — on exige explicitement
  // la présence de `me` et `noiseKey`, marqueurs d'un pairing réel.
  const hasValidCreds =
    existing?.creds &&
    typeof existing.creds === "object" &&
    existing.creds.noiseKey &&
    existing.creds.signedIdentityKey;

  const creds = hasValidCreds
    ? JSON.parse(JSON.stringify(existing.creds), BufferJSON.reviver)
    : initAuthCreds();

  if (existing?.creds && !hasValidCreds) {
    await log(
      "warn",
      `Creds Mongo présents mais invalides/incomplets pour ${userId} — réinitialisation forcée`,
      { userId },
    );
  }

  // ─────────────────────────────────────────────
  // Persistance des creds — jamais silencieuse en cas d'échec
  // ─────────────────────────────────────────────
  const saveCreds = async () => {
    const serialized = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    try {
      await WhatsAppAuth.findOneAndUpdate(
        { userId },
        { $set: { creds: serialized } },
        { upsert: true },
      );
    } catch (err) {
      await log(
        "error",
        `ÉCHEC critique de sauvegarde des creds pour ${userId} : ${err.message}`,
        { userId },
      );
      throw err;
    }
  };

  // ─────────────────────────────────────────────
  // Clés Signal — un document Mongo par clé, écritures indépendantes.
  // Élimine tout risque d'écrasement entre écritures concurrentes.
  // ─────────────────────────────────────────────
  const keys = {
    get: async (type, ids) => {
      const result = {};
      const encodedIds = ids.map(encodeId);

      const docs = await WhatsAppKey.find({
        userId,
        category: type,
        keyId: { $in: encodedIds },
      }).lean();

      for (const doc of docs) {
        const id = decodeId(doc.keyId);
        let value = JSON.parse(JSON.stringify(doc.value), BufferJSON.reviver);
        if (type === "app-state-sync-key" && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        result[id] = value;
      }
      return result;
    },

    set: async (data) => {
      const ops = [];

      for (const category of Object.keys(data)) {
        for (const id of Object.keys(data[category])) {
          const value = data[category][id];
          const encodedId = encodeId(id);

          if (value === null || value === undefined) {
            ops.push(
              WhatsAppKey.deleteOne({ userId, category, keyId: encodedId }),
            );
          } else {
            const serialized = JSON.parse(
              JSON.stringify(value, BufferJSON.replacer),
            );
            ops.push(
              WhatsAppKey.findOneAndUpdate(
                { userId, category, keyId: encodedId },
                { $set: { value: serialized } },
                { upsert: true },
              ),
            );
          }
        }
      }

      const results = await Promise.allSettled(ops);
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        await log(
          "error",
          `${failures.length} écriture(s) de clé(s) échouée(s) pour ${userId}`,
          { userId, errors: failures.map((f) => f.reason?.message) },
        );
      }
    },
  };

  return { state: { creds, keys }, saveCreds };
};

/**
 * Supprime intégralement la session d'un utilisateur (creds + toutes les clés).
 * À utiliser sur logout explicite (401) ou reset manuel.
 */
export const clearAuthState = async (userId) => {
  await Promise.all([
    WhatsAppAuth.deleteOne({ userId }),
    WhatsAppKey.deleteMany({ userId }),
  ]);
  await log("info", `Session Mongo entièrement effacée pour ${userId}`, {
    userId,
  });
};
