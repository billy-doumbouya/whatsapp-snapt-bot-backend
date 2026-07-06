export const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export const assertRequiredFields = (body, fields) => {
  const missing = fields.filter((f) => !body[f]);
  if (missing.length) {
    const err = new Error(`Champs requis manquants : ${missing.join(", ")}`);
    err.status = 400;
    throw err;
  }
};