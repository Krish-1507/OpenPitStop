import { execFile } from "node:child_process";

const DIRS = { uploads: "/srv/uploads", logs: "/srv/logs" };

export function listDir(req, done) {
  const dir = DIRS[req.query.dir] ?? "/srv/uploads";
  return execFile("ls", ["-l", dir], done);
}
