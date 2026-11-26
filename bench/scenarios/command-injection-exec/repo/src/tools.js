import { exec } from "node:child_process";

export function listDir(req, done) {
  return exec("ls " + req.query.dir, done);
}
