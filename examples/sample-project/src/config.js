import { readFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULTS = { currency: "USD", taxRate: 0, freeShippingOverCents: 5000 };

/** Reads `store.json` from a directory and merges it over the defaults. A missing file means defaults. */
export async function loadConfig(dir) {
  let raw;
  try {
    raw = await readFile(path.join(dir, "store.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { ...DEFAULTS };
    throw error;
  }

  const parsed = JSON.parse(raw);
  if (parsed.taxRate !== undefined && (parsed.taxRate < 0 || parsed.taxRate > 1)) {
    throw new RangeError("taxRate must be between 0 and 1");
  }
  return { ...DEFAULTS, ...parsed };
}
