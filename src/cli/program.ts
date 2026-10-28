import { readFileSync } from "node:fs";
import { Command } from "commander";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerGenerateCommand } from "./commands/generate.js";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export function createProgram(): Command {
  const program = new Command()
    .name("assertloom")
    .description("Assertloom: AI-generated Jest tests that are executed, verified, and repaired.")
    .version(version)
    .showHelpAfterError();

  registerAnalyzeCommand(program);
  registerGenerateCommand(program);

  return program;
}
