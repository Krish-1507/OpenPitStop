const _ = require("lodash");
const db = require("./db");
// Circular dependency: users -> server -> users. PitStop's dependency-graph
// analyzer detects the cycle.
const server = require("./server");

// BUG: prototype pollution sink — untrusted request body merged into target.
function mergeProfile(target, body) {
  return _.merge(target, body); // lodash@4.17.4 is CVE-2019-10744
}

// BUG: N+1 — fetch all users, then one query per user for their orders.
function usersWithOrders() {
  const users = db.pool.query("SELECT * FROM users");
  for (const u of users) {
    u.orders = db.pool.query(`SELECT * FROM orders WHERE user_id = ${u.id}`);
  }
  return users;
}

module.exports = { mergeProfile, usersWithOrders };
