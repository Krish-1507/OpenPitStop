import { pool } from "./client.js";

function buildQuery(id) {
  return "SELECT id FROM users WHERE id = " + id;
}

export async function findUser(req) {
  const query = buildQuery(req.params.id);
  return pool.query(query);
}
