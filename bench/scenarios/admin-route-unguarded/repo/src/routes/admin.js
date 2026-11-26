import { router } from "../app.js";
import { allUsers } from "../store.js";

router.get("/admin/users", async (req, res) => {
  res.json(await allUsers());
});
