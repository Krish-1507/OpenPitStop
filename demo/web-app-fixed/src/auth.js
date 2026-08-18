const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const config = require("./config");

// FIXED: constant-time hash compare, never plain ===.
async function checkPassword(plain, storedHash) {
  return bcrypt.compare(plain, storedHash);
}

// FIXED: store only a salted hash.
async function saveUserPassword(userId, password) {
  const hash = await bcrypt.hash(password, 12);
  return { userId, hash }; // persisted via a parameterized UPDATE
}

// FIXED: unpredictable token from a CSPRNG, not Math.random().
function newSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

// FIXED: JWT signed with a long env secret; verified with an explicit alg
// allowlist (no alg:none).
function issueToken(user) {
  return jwt.sign({ sub: user.id }, config.JWT_SECRET, {
    expiresIn: "1h",
    algorithm: "HS256",
  });
}

function verifyToken(token) {
  return jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] });
}

// FIXED: secure cookie — httpOnly + secure + sameSite.
function setSessionCookie(res, token) {
  res.cookie("session", token, { httpOnly: true, secure: true, sameSite: "lax" });
}

module.exports = {
  checkPassword,
  saveUserPassword,
  newSessionToken,
  issueToken,
  verifyToken,
  setSessionCookie,
};
