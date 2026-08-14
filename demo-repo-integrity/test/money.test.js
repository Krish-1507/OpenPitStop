const { round2, quoteWithMarkup, splitFair } = require("../src/money");

describe("pitstop-demo-integrity", () => {
  it("rounds half-cent values up to the nearest cent", () => {
    // The float bug: 8.075 * 100 = 807.4999999999999 -> 8.07. Correct: 8.08.
    expect(round2(8.075)).toBe(8.08);
  });

  it("quotes base + 7.5% markup to the cent", () => {
    // 19.99 * 1.075 = 21.48925 -> 21.49
    expect(quoteWithMarkup(19.99, 7.5)).toBe(21.49);
  });

  it("splits a bill evenly to the cent", () => {
    expect(splitFair(100, 3)).toBe(33.33);
  });
});
