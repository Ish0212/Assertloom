import { add, divide } from "./calc";

describe("add", () => {
  it("adds two numbers", () => {
    expect(add(2, 3)).toBe(5);
  });
});

describe("divide", () => {
  it("divides", () => {
    expect(divide(10, 4)).toBe(2.5);
  });

  it("throws when dividing by zero", () => {
    expect(() => divide(1, 0)).toThrow("Cannot divide by zero");
  });
});
