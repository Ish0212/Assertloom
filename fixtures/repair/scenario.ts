/**
 * Intentionally failing generated tests for `pricing.ts`, and the repairs a model proposes.
 * The repair loop must end with every test passing or explicitly skipped, without editing pricing.ts.
 *
 * | Test                                       | Initial failure                    | Category   | Expected handling                            |
 * | ------------------------------------------ | ---------------------------------- | ---------- | -------------------------------------------- |
 * | applyDiscount › applies a 15% discount     | wrong expected value (17)          | assertion  | fixed in attempt 1 (16.99)                   |
 * | applyDiscount › rejects percentages > 100  | passes                             |            | must keep passing                            |
 * | formatPrice › formats cents as dollars     | wrong format ("$12.50")            | assertion  | fixed in attempt 1 ("USD 12.50")             |
 * | formatPrice › uses the given currency      | misspelled binding (formatprice)   | runtime    | fixed in attempt 1                           |
 * | parseQuantity › parses integers            | passes                             |            | must keep passing                            |
 * | parseQuantity › rejects non-numeric input  | wrong error message                | assertion  | attempt 1 proposal uses require() and is     |
 * |                                            |                                    |            | rejected; fixed in attempt 2                 |
 * | average › averages values                  | passes                             |            | must keep passing                            |
 * | average › returns 0 for an empty list      | source returns NaN (a real bug)    | assertion  | skipped as a suspected source bug            |
 * | slowDouble › doubles a number              | missing await (received a Promise) | assertion  | fixed in attempt 1 with await                |
 * | fetchRate › returns the rate               | fetch mock never configured        | assertion  | fixed in attempt 1 (mockResolvedValue)       |
 */
import type { Generation } from "../../src/generator/schema.js";
import type { RepairResponse } from "../../src/repair/schema.js";

export const initialGeneration: Generation = {
  suites: [
    {
      functionName: "applyDiscount",
      cases: [
        { name: "applies a 15% discount", category: "normal", body: "expect(applyDiscount(19.99, 15)).toBe(17);" },
        { name: "rejects percentages above 100", category: "error", body: "expect(() => applyDiscount(10, 150)).toThrow(RangeError);" },
      ],
    },
    {
      functionName: "formatPrice",
      cases: [
        { name: "formats cents as dollars", category: "normal", body: 'expect(formatPrice(1250)).toBe("$12.50");' },
        { name: "uses the given currency", category: "normal", body: 'expect(formatprice(500, "EUR")).toBe("EUR 5.00");' },
      ],
    },
    {
      functionName: "parseQuantity",
      cases: [
        { name: "parses integers", category: "normal", body: 'expect(parseQuantity("42")).toBe(42);' },
        { name: "rejects non-numeric input", category: "error", body: 'expect(() => parseQuantity("abc")).toThrow("Quantity must be a number");' },
      ],
    },
    {
      functionName: "average",
      cases: [
        { name: "averages values", category: "normal", body: "expect(average([1, 2, 3])).toBe(2);" },
        { name: "returns 0 for an empty list", category: "edge", body: "expect(average([])).toBe(0);" },
      ],
    },
    {
      functionName: "slowDouble",
      cases: [{ name: "doubles a number", category: "normal", body: "expect(slowDouble(2)).toBe(4);" }],
    },
    {
      functionName: "fetchRate",
      cases: [{ name: "returns the rate", category: "normal", body: 'await expect(fetchRate("EUR")).resolves.toBeGreaterThan(0);' }],
    },
  ],
};

export const repairsByAttempt: Record<number, RepairResponse> = {
  1: {
    repairs: [
      {
        functionName: "applyDiscount",
        name: "applies a 15% discount",
        action: "fix",
        body: "expect(applyDiscount(19.99, 15)).toBe(16.99);",
        reason: "19.99 * 0.85 rounds to 16.99, not 17.",
      },
      {
        functionName: "formatPrice",
        name: "formats cents as dollars",
        action: "fix",
        body: 'expect(formatPrice(1250)).toBe("USD 12.50");',
        reason: "formatPrice prefixes the currency code, not a symbol.",
      },
      {
        functionName: "formatPrice",
        name: "uses the given currency",
        action: "fix",
        body: 'expect(formatPrice(500, "EUR")).toBe("EUR 5.00");',
        reason: "The binding is formatPrice.",
      },
      {
        functionName: "parseQuantity",
        name: "rejects non-numeric input",
        action: "fix",
        body: 'const { parseQuantity: p } = require("./pricing");\nexpect(() => p("abc")).toThrow();',
        reason: "Re-import the function.",
      },
      {
        functionName: "average",
        name: "returns 0 for an empty list",
        action: "skip",
        body: "",
        reason: "average([]) divides by zero and returns NaN, but its documentation says it returns 0.",
      },
      {
        functionName: "slowDouble",
        name: "doubles a number",
        action: "fix",
        body: "await expect(slowDouble(2)).resolves.toBe(4);",
        reason: "slowDouble is async; the test must await the result.",
      },
      {
        functionName: "fetchRate",
        name: "returns the rate",
        action: "fix",
        body: 'jest.mocked(fetch).mockResolvedValue({ json: async () => ({ rate: 1.1 }) } as any);\nawait expect(fetchRate("EUR")).resolves.toBe(1.1);',
        reason: "fetch is mocked and returns undefined until configured.",
      },
    ],
  },
  2: {
    repairs: [
      {
        functionName: "parseQuantity",
        name: "rejects non-numeric input",
        action: "fix",
        body: 'expect(() => parseQuantity("abc")).toThrow("Invalid quantity: abc");',
        reason: "The source throws `Invalid quantity: ${input}`.",
      },
    ],
  },
};

export function repairAttemptOf(prompt: string): number {
  return Number(/Repair attempt (\d+)/.exec(prompt)?.[1] ?? 0);
}
