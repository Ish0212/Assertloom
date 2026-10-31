/**
 * Model output for the mocking fixtures, written the way a model would given Assertloom's mock summary.
 * Each scenario must pass under real Jest with only Assertloom's generated mocks.
 *
 * | Source                        | Dependency shape                                         | Module system           |
 * | ----------------------------- | -------------------------------------------------------- | ----------------------- |
 * | examples/users.ts             | axios default export + pg Pool created at load (2 pkgs)  | TypeScript ESM          |
 * | weather.ts                    | global fetch                                             | TypeScript ESM          |
 * | orders.cjs                    | local ./db.cjs wrapping pg (mocked), ./money.cjs (real)  | CommonJS                |
 * | settings.mjs                  | node:fs/promises named import, node:path kept real       | .mjs ESM                |
 * | esm-project/git.js            | node:child_process named import                          | .js in "type": "module" |
 */
import type { Generation } from "../../src/generator/schema.js";

export interface MockingScenario {
  /** Path relative to the repository root. */
  file: string;
  generation: Generation;
  tests: number;
}

export const scenarios: MockingScenario[] = [
  {
    file: "examples/users.ts",
    tests: 8,
    generation: {
      suites: [
        {
          functionName: "getUser",
          cases: [
            {
              name: "returns the database row when it exists",
              category: "normal",
              body: `jest.mocked(pool.query).mockResolvedValue({ rows: [{ id: 1, name: "Ada", email: "ada@example.com" }] } as any);
await expect(getUser(1)).resolves.toEqual({ id: 1, name: "Ada", email: "ada@example.com" });
expect(pool.query).toHaveBeenCalledWith("SELECT id, name, email FROM users WHERE id = $1", [1]);
expect(axios.get).not.toHaveBeenCalled();`,
            },
            {
              name: "falls back to the profile API when the row is missing",
              category: "normal",
              body: `jest.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
jest.mocked(axios.get).mockResolvedValue({ data: { id: 2, name: "Bo", email: "bo@example.com" } });
await expect(getUser(2)).resolves.toEqual({ id: 2, name: "Bo", email: "bo@example.com" });
expect(axios.get).toHaveBeenCalledWith("https://api.example.com/users/2");`,
            },
            {
              name: "rejects ids that are not positive integers",
              category: "error",
              body: `await expect(getUser(0)).rejects.toThrow("id must be a positive integer");
await expect(getUser(1.5)).rejects.toThrow(RangeError);
expect(pool.query).not.toHaveBeenCalled();`,
            },
            {
              name: "propagates database errors",
              category: "error",
              body: `jest.mocked(pool.query).mockRejectedValue(new Error("connection lost"));
await expect(getUser(3)).rejects.toThrow("connection lost");`,
            },
          ],
        },
        {
          functionName: "importUser",
          cases: [
            {
              name: "stores the user with a lowercased email",
              category: "normal",
              body: `jest.mocked(axios.get).mockResolvedValue({ data: { id: 4, name: "Cy", email: "CY@Example.COM" } });
jest.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
await expect(importUser(4)).resolves.toBe(true);
expect(pool.query).toHaveBeenCalledWith("INSERT INTO users (id, name, email) VALUES ($1, $2, $3)", [4, "Cy", "cy@example.com"]);`,
            },
            {
              name: "returns false when the API has no such user",
              category: "edge",
              body: `jest.mocked(axios.get).mockRejectedValue({ response: { status: 404 } });
jest.mocked(axios.isAxiosError).mockReturnValue(true);
await expect(importUser(5)).resolves.toBe(false);
expect(pool.query).not.toHaveBeenCalled();`,
            },
            {
              name: "rethrows other API errors",
              category: "error",
              body: `jest.mocked(axios.get).mockRejectedValue(new Error("timeout"));
jest.mocked(axios.isAxiosError).mockReturnValue(false);
await expect(importUser(6)).rejects.toThrow("timeout");`,
            },
          ],
        },
        {
          functionName: "countUsersByDomain",
          cases: [
            {
              name: "counts users in a lowercased domain",
              category: "normal",
              body: `jest.mocked(pool.query).mockResolvedValue({ rows: [{ count: "3" }] } as any);
await expect(countUsersByDomain("Example.COM")).resolves.toBe(3);
expect(pool.query).toHaveBeenCalledWith("SELECT COUNT(*) AS count FROM users WHERE email LIKE $1", ["%@example.com"]);`,
            },
          ],
        },
      ],
    },
  },
  {
    file: "fixtures/mocking/weather.ts",
    tests: 3,
    generation: {
      suites: [
        {
          functionName: "getForecast",
          cases: [
            {
              name: "rounds the temperature and encodes the city",
              category: "normal",
              body: `jest.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ temp_c: 21.6 }) } as any);
await expect(getForecast("São Paulo")).resolves.toEqual({ city: "São Paulo", celsius: 22 });
expect(fetch).toHaveBeenCalledWith("https://weather.example.com/v1/current?city=S%C3%A3o%20Paulo");`,
            },
            {
              name: "rejects when the API responds with an error status",
              category: "error",
              body: `jest.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as any);
await expect(getForecast("Oslo")).rejects.toThrow("Weather API error: 503");`,
            },
            {
              name: "propagates network failures",
              category: "error",
              body: `jest.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));
await expect(getForecast("Oslo")).rejects.toThrow("fetch failed");`,
            },
          ],
        },
      ],
    },
  },
  {
    file: "fixtures/mocking/orders.cjs",
    tests: 3,
    generation: {
      suites: [
        {
          functionName: "customerTotal",
          cases: [
            {
              name: "sums order amounts and formats them",
              category: "normal",
              body: `db.query.mockResolvedValue([{ amount_cents: 1250 }, { amount_cents: 99 }]);
await expect(customerTotal(7)).resolves.toBe("$13.49");
expect(db.query).toHaveBeenCalledWith("SELECT amount_cents FROM orders WHERE customer_id = $1", [7]);`,
            },
            {
              name: "returns $0.00 for a customer without orders",
              category: "edge",
              body: `db.query.mockResolvedValue([]);
await expect(customerTotal(8)).resolves.toBe("$0.00");`,
            },
            {
              name: "propagates query errors",
              category: "error",
              body: `db.query.mockRejectedValue(new Error("deadlock"));
await expect(customerTotal(9)).rejects.toThrow("deadlock");`,
            },
          ],
        },
      ],
    },
  },
  {
    file: "fixtures/mocking/settings.mjs",
    tests: 3,
    generation: {
      suites: [
        {
          functionName: "loadSettings",
          cases: [
            {
              name: "merges the file over the defaults",
              category: "normal",
              body: `readFile.mockResolvedValue('{"theme":"dark"}');
await expect(loadSettings("/app")).resolves.toEqual({ theme: "dark", pageSize: 20 });
expect(readFile).toHaveBeenCalledWith(expect.stringContaining("settings.json"), "utf8");`,
            },
            {
              name: "returns the defaults when the file is missing",
              category: "edge",
              body: `readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
await expect(loadSettings("/app")).resolves.toEqual({ theme: "light", pageSize: 20 });`,
            },
            {
              name: "rethrows other read errors",
              category: "error",
              body: `readFile.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
await expect(loadSettings("/app")).rejects.toThrow("permission denied");`,
            },
          ],
        },
      ],
    },
  },
  {
    file: "fixtures/mocking/esm-project/git.js",
    tests: 1,
    generation: {
      suites: [
        {
          functionName: "currentBranch",
          cases: [
            {
              name: "returns the trimmed branch name",
              category: "normal",
              body: `execFileSync.mockReturnValue("main\\n");
expect(currentBranch("/repo")).toBe("main");
expect(execFileSync).toHaveBeenCalledWith("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: "/repo", encoding: "utf8" });`,
            },
          ],
        },
      ],
    },
  },
];
