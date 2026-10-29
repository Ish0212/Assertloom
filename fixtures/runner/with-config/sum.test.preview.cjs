const { sum } = require("./sum.cjs");

test("sums values", () => {
  expect(sum([1, 2, 3])).toBe(6);
});

test("returns 0 for an empty list", () => {
  expect(sum([])).toBe(0);
});
