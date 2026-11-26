export async function findUser(db, email) {
  const rows = await db.query("SELECT id, password FROM users WHERE email = $1", [email]);
  return rows[0];
}
