import { pool } from "./client.js";

export async function findOrder(req) {
  const ref = req.query.ref;
  return pool.query("SELECT id, total FROM orders WHERE ref = '" + ref + "'");
}
