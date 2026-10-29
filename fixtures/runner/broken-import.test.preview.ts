import { add } from "./does-not-exist";

it("never runs", () => {
  expect(add(1, 2)).toBe(3);
});
