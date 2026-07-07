import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import WhatsAppAuth from "../models/WhatsAppAuth.js";

export const useMongoAuthState = async (userId) => {
  const existing = await WhatsAppAuth.findOne({ userId }).lean();

  const stored = existing?.data
    ? JSON.parse(JSON.stringify(existing.data), BufferJSON.reviver)
    : {};

  const creds = stored.creds || initAuthCreds();
  const keys = stored.keys || {};

  const persist = async () => {
    const serialized = JSON.parse(
      JSON.stringify({ creds, keys }, BufferJSON.replacer),
    );
    await WhatsAppAuth.findOneAndUpdate(
      { userId },
      { data: serialized },
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
          await persist();
        },
      },
    },
    saveCreds: persist,
  };
};