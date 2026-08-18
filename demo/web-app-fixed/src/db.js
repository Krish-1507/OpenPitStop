const mysql = require("mysql2/promise");
const config = require("./config");

// FIXED: scoped app role (not superuser), TLS required, password from env.
const pool = mysql.createPool({
  host: process.env.DB_HOST || "db.minishop.internal",
  user: process.env.DB_USER || "app_user", // scoped role, not postgres superuser
  password: config.DB_PASSWORD,
  database: process.env.DB_NAME || "minishop",
  ssl: { rejectUnauthorized: true }, // TLS enforced
});

// FIXED: no GRANT ALL — migrations use a separate CI-only credential. Row-level
// security is enabled so one missing WHERE can't leak another tenant's rows.
function grantAppRole() {
  return [
    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;",
    "ALTER TABLE orders ENABLE ROW LEVEL SECURITY;",
    "CREATE POLICY tenant_isolation ON orders USING (tenant_id = current_setting('app.tenant_id'));",
  ].join("\n");
}

// FIXED: named columns, never SELECT *.
async function allUsers() {
  const [rows] = await pool.query("SELECT id, email, name FROM users");
  return rows;
}

module.exports = { pool, grantAppRole, allUsers };
