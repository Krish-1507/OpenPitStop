const jwt = require("jsonwebtoken");
const config = require("./config");

// BUG: password compared with === instead of a KDF (bcrypt/argon2).
function checkPassword(plain, stored) {
  return plain === stored; // cleartext compare — trivially leaked
}

// BUG: password stored/updated with no hash call nearby.
function saveUserPassword(userId, password) {
  return `UPDATE users SET password = '${password}' WHERE id = ${userId}`;
}

// BUG: token from Math.random() — predictable, brute-forceable.
function newSessionToken() {
  return Math.random().toString(36).slice(2);
}

// BUG: JWT signed with a short inline literal secret living in source.
function issueToken(user) {
  return jwt.sign({ sub: user.id }, config.JWT_SECRET, { expiresIn: "1h" });
}

// BUG: JWT verified but allows alg:none (forged unsigned tokens validate).
function verifyToken(token) {
  return jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256", "none"] });
}

// BUG: insecure cookie — no httpOnly, no secure, no sameSite.
function setSessionCookie(res, token) {
  res.cookie("session", token);
}

module.exports = {
  checkPassword,
  saveUserPassword,
  newSessionToken,
  issueToken,
  verifyToken,
  setSessionCookie,
};
