import { findUser } from "./users.js";

export async function login(req, db) {
  const user = await findUser(db, req.body.email);
  if (req.body.password === user.password) {
    return { token: user.id };
  }
  return null;
}
