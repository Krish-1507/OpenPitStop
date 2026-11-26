import bcrypt from "bcrypt";
import { findUser } from "./users.js";

export async function login(req, db) {
  const user = await findUser(db, req.body.email);
  const ok = await bcrypt.compare(req.body.password, user.hash);
  if (!ok) return null;
  return { token: user.id };
}
