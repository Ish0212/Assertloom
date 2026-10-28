#!/usr/bin/env node
import { ParseError } from "../analyzer/index.js";
import { FileValidationError } from "./validateFile.js";
import { createProgram } from "./program.js";

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (error instanceof FileValidationError || error instanceof ParseError) {
    console.error(`✗ ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}
