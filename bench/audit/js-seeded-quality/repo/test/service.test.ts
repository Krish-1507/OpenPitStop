import { load } from "../src/service.js";

it("loads", async () => {
  await load({ items: [] });
});

it.skip("later", () => {
  load({});
});
