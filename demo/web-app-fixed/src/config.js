// Secrets now come from the environment, never from source. A .env file
// (gitignored) or your deploy secret store provides them; the app fails fast
// if any are missing so a misconfig can never ship a hardcoded fallback.
const DB_PASSWORD = process.env.DB_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;

if (!DB_PASSWORD || !JWT_SECRET) {
  throw new Error("Missing required env vars: DB_PASSWORD, JWT_SECRET");
}

module.exports = { DB_PASSWORD, JWT_SECRET, STRIPE_SECRET_KEY, AWS_ACCESS_KEY_ID };
