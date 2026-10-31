import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULTS = { theme: "light", pageSize: 20 };

export async function loadSettings(dir) {
  let text;
  try {
    text = await readFile(path.join(dir, "settings.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { ...DEFAULTS };
    throw error;
  }
  return { ...DEFAULTS, ...JSON.parse(text) };
}
