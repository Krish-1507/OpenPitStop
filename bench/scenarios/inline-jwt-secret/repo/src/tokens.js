import jwt from "jsonwebtoken";

export function issue(user) {
  return jwt.sign({ sub: user.id }, "dev-secret");
}
