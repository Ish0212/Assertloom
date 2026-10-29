#!/usr/bin/env node
import { UserError } from "../errors.js";
import { createProgram } from "./program.js";

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (error instanceof UserError) {
    console.error(`✗ ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}
