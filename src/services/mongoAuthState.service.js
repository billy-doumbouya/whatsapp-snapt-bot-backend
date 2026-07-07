import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import WhatsAppAuth from "../models/WhatsAppAuth.js";

/**
 * MongoDB/Mongoose n'accepte pas bien les "." (ni les "$") comme noms de champs
 * imbriqués. Les IDs de clés Signal générés par Baileys (session, sender-key,
 * pre-key...) contiennent très souvent des points (ex: "221xxxxxxxxx.0"),
 * ce qui faisait échouer silencieusement l'écriture Mongo pendant le
 * handshake initial après scan du QR. On encode donc chaque ID en base64url
 * avant de l'utiliser comme clé d'objet stockée, et on le décode à la lecture.
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
  const existing = await WhatsAppAuth.findOne({ userId }).lean();

  const storedCreds = existing?.creds
    ? JSON.parse(JSON.stringify(existing.creds), BufferJSON.reviver)
    : null;
  const storedKeys = existing?.keys
    ? JSON.parse(JSON.stringify(existing.keys), BufferJSON.reviver)
    : {};

  const creds = storedCreds || initAuthCreds();

  const keys = {};
  for (const category of Object.keys(storedKeys)) {
    keys[category] = {};
    for (const encodedId of Object.keys(storedKeys[category])) {
      keys[category][decodeId(encodedId)] = storedKeys[category][encodedId];
    }
  }

  const persistCreds = async () => {
    const serialized = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    await WhatsAppAuth.findOneAndUpdate(
      { userId },
      { creds: serialized },
      { upsert: true },
    );
  };

  const persistKeys = async () => {
    const encodedKeys = {};
    for (const category of Object.keys(keys)) {
      encodedKeys[category] = {};
      for (const id of Object.keys(keys[category])) {
        encodedKeys[category][encodeId(id)] = keys[category][id];
      }
    }
    const serialized = JSON.parse(
      JSON.stringify(encodedKeys, BufferJSON.replacer),
    );
    await WhatsAppAuth.findOneAndUpdate(
      { userId },
      { keys: serialized },
      { upsert: true },
    );
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          for (const id of ids) {
            const value = keys[type]?.[id];
            if (value !== undefined) result[id] = value;
          }
          return result;
        },
        set: async (data) => {
          for (const category of Object.keys(data)) {
            keys[category] = keys[category] || {};
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              if (value === null || value === undefined) {
                delete keys[category][id];
              } else {
                keys[category][id] = value;
              }
            }
          }
          await persistKeys();
        },
      },
    },
    saveCreds: persistCreds,
  };
};