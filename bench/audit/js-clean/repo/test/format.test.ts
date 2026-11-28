import { format } from "../src/format.js";

it("formats a value", () => {
  expect(format(1)).toBe("value=2");
});
