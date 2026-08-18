// Hardcoded secrets in source — flagged by the secret analyzer even without .env.
// NOTE: values are obvious FAKE placeholders (no real AKIA/sk_live prefixes) so the
// repo passes GitHub push protection; OpenPitStop still flags them by variable name.
const AWS_ACCESS_KEY_ID = "example-aws-access-key-id-not-real";
const STRIPE_SECRET_KEY = "example-stripe-secret-key-not-real";
const JWT_SECRET = "example-jwt-secret-not-real";
const DB_PASSWORD = "example-db-password-not-real";

module.exports = { AWS_ACCESS_KEY_ID, STRIPE_SECRET_KEY, JWT_SECRET, DB_PASSWORD };
