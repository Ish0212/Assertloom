import { add, divide, sign } from "./calc";

describe("add", () => {
  it("adds two numbers", () => {
    expect(add(2, 3)).toBe(5);
  });

  it("has a wrong expectation", () => {
    expect(add(2, 2)).toBe(5);
  });
});

describe("divide", () => {
  it("calls a method that does not exist", () => {
    const result = divide(4, 2) as unknown as { toFixedd(): string };
    expect(result.toFixedd()).toBe("2");
  });
});

describe("sign", () => {
  it("waits forever", async () => {
    await new Promise(() => {});
    expect(sign(1)).toBe("positive");
  });
});
