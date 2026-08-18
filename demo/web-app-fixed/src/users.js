const db = require("./db");

// FIXED: circular dependency removed — users no longer imports server.
// Prototype-pollution sink gone: only known fields are copied, never a raw
// untrusted object merge (and lodash is bumped to 4.17.21 regardless).
function mergeProfile(target, body) {
  const allowed = ["displayName", "bio"];
  for (const k of allowed) {
    if (k in body) target[k] = body[k];
  }
  return target;
}

// FIXED: N+1 eliminated — one query with an IN (...) instead of per-user loops.
async function usersWithOrders() {
  const users = await db.allUsers();
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return [];
  const [orders] = await db.pool.query("SELECT id, user_id, total FROM orders WHERE user_id IN (?)", [ids]);
  const byUser = new Map();
  for (const o of orders) byUser.set(o.user_id, (byUser.get(o.user_id) || []).concat(o));
  return users.map((u) => ({ ...u, orders: byUser.get(u.id) || [] }));
}

module.exports = { mergeProfile, usersWithOrders };
