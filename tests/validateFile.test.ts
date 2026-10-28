import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileValidationError, validateSourceFile } from "../src/cli/validateFile.js";

const root = path.resolve(import.meta.dirname, "..");

describe("validateSourceFile", () => {
  it("accepts a TypeScript source file", async () => {
    const source = await validateSourceFile("examples/math.ts", root);

    expect(source.absolutePath).toBe(path.join(root, "examples", "math.ts"));
    expect(source.extension).toBe(".ts");
    expect(source.language).toBe("typescript");
    expect(source.sizeBytes).toBeGreaterThan(0);
  });

  it("rejects a missing file", async () => {
    await expect(validateSourceFile("examples/nope.ts", root)).rejects.toThrow(/File not found/);
  });

  it("rejects an unsupported extension", async () => {
    await expect(validateSourceFile("fixtures/unsupported.py", root)).rejects.toThrow(/Unsupported file type ".py"/);
  });

  it("rejects a file with no extension", async () => {
    await expect(validateSourceFile("LICENSE", root)).rejects.toThrow(/"\(none\)"/);
  });

  it("rejects a directory", async () => {
    const result = validateSourceFile("fixtures/directory.ts", root);

    await expect(result).rejects.toBeInstanceOf(FileValidationError);
    await expect(result).rejects.toThrow(/Not a file/);
  });

  it("rejects existing test files", async () => {
    await expect(validateSourceFile("tests/validateFile.test.ts", root)).rejects.toThrow(/looks like a test file/);
  });
});
