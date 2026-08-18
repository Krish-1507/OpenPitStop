const mysql = require("mysql2");
const config = require("./config");

// BUG: privileged superuser account, committed password, TLS-free connection.
const pool = mysql.createPool({
  host: "db.minishop.internal",
  user: "postgres", // superuser, not a scoped app role
  password: config.DB_PASSWORD, // committed in source + .env
  database: "minishop",
  // BUG: TLS disabled — credentials cross the wire in cleartext.
  ssl: false,
});

// BUG: GRANT ALL — the app role can DROP tables and alter schema.
function grantAll() {
  return "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres;";
}

// BUG: SELECT * — password/hash/internal columns ride along to every caller.
function allUsers() {
  return pool.query("SELECT * FROM users");
}

module.exports = { pool, grantAll, allUsers };
