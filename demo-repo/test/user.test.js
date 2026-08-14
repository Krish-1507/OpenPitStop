const service = require("../src/userService");

describe("pitstop-demo-api", () => {
  it("assigns the correct tier for a mid score", () => {
    // score 30 -> +10 = 40 -> should be "silver"
    expect(service.calculateTier(30)).toBe("silver");
  });

  it("uppercases the name", () => {
    expect(service.normalizeName("bob")).toBe("BOB");
  });
});
