import type { Command } from "commander";
import { validateSourceFile } from "../validateFile.js";

export function registerGenerateCommand(program: Command): void {
  program
    .command("generate")
    .description("Generate, run, and repair Jest tests for a source file (not implemented yet)")
    .argument("<file>", "path to a JavaScript or TypeScript source file")
    .action(async (file: string) => {
      const source = await validateSourceFile(file);

      console.log(`✓ ${source.inputPath} can be processed`);
      console.log("Test generation is not implemented yet. Use `assertloom analyze` for now.");
    });
}
