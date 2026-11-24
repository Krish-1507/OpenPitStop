import { router } from "../app.js";
import { requireAuth, requireRole } from "../guards.js";
import { allUsers } from "../store.js";

router.get("/admin/users", requireAuth, requireRole("admin"), async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).end();
  res.json(await allUsers());
});
