import { pool } from "./client.js";

export async function findOrder(req) {
  return pool.query("SELECT id, total FROM orders WHERE ref = $1", [req.query.ref]);
}
