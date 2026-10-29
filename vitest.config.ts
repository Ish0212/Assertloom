import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Generated Jest tests (examples/*.test.ts, fixtures) must not be picked up by Vitest.
    include: ["tests/**/*.test.ts"],
  },
});
