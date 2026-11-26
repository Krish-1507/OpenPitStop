import jwt from "jsonwebtoken";

export function issue(user) {
  return jwt.sign({ sub: user.id }, process.env.JWT_SECRET);
}
