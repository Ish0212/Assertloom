import { execFileSync } from "node:child_process";

export function currentBranch(cwd) {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim();
}
