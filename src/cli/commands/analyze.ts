import type { Command } from "commander";
import { validateSourceFile } from "../validateFile.js";

interface AnalyzeOptions {
  json?: boolean;
}

export function registerAnalyzeCommand(program: Command): void {
  program
    .command("analyze")
    .description("Check that a JS/TS source file can be processed by Assertloom")
    .argument("<file>", "path to a JavaScript or TypeScript source file")
    .option("--json", "print machine-readable output")
    .action(async (file: string, options: AnalyzeOptions) => {
      const source = await validateSourceFile(file);

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              file: source.inputPath.replaceAll("\\", "/"),
              absolutePath: source.absolutePath,
              language: source.language,
              extension: source.extension,
              sizeBytes: source.sizeBytes,
              processable: true,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(`✓ Found ${source.inputPath} (${source.sizeBytes} bytes)`);
      console.log(`✓ Supported ${source.language === "typescript" ? "TypeScript" : "JavaScript"} file (${source.extension})`);
      console.log("✓ Ready for analysis");
      console.log(`\nPath: ${source.absolutePath}`);
    });
}
