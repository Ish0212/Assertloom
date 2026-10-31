import { stat } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { FileValidationError, validateSourceFile } from "../validateFile.js";
import { runJest } from "../../runner/index.js";
import { printRunResult } from "../report.js";

interface RunCommandOptions {
  source?: string;
  timeout: string;
  json?: boolean;
  allowNetwork?: boolean;
}

/** `math.test.preview.ts` / `math.test.ts` / `math.spec.ts` → `math.ts`. */
export function inferSourcePath(testPath: string): string | undefined {
  const inferred = testPath.replace(/\.(test|spec)(\.preview)?(?=\.[cm]?[jt]sx?$)/, "");
  return inferred === testPath ? undefined : inferred;
}

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Run a test file with Jest and report results and coverage of its source file")
    .argument("<testFile>", "test file to run, such as math.test.preview.ts")
    .option("--source <file>", "source file to measure coverage for (default: inferred from the test file name)")
    .option("--timeout <seconds>", "kill Jest if it runs longer than this", "120")
    .option("--json", "print the full result as JSON")
    .option("--allow-network", "let the tests open network connections (blocked by default)")
    .action(async (testFile: string, options: RunCommandOptions) => {
      const testPath = path.resolve(testFile);
      try {
        if (!(await stat(testPath)).isFile()) throw new Error();
      } catch {
        throw new FileValidationError(`Test file not found: ${testFile}`);
      }

      const sourceArg = options.source ?? inferSourcePath(testFile);
      if (!sourceArg) throw new FileValidationError(`Cannot infer the source file from ${testFile}; pass --source.`);
      const source = await validateSourceFile(sourceArg);

      const timeoutSeconds = Number(options.timeout);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new FileValidationError("--timeout must be a positive number.");

      const result = await runJest({
        testPath,
        sourcePath: source.absolutePath,
        timeoutMs: timeoutSeconds * 1000,
        allowNetwork: !!options.allowNetwork,
      });

      if (options.json) console.log(JSON.stringify(result, null, 2));
      else printRunResult(result);

      if (result.status !== "passed") process.exitCode = 1;
    });
}
