import { parse, type ParserPlugin } from "@babel/parser";
import type { File } from "@babel/types";
import { UserError } from "../errors.js";
import type { SupportedExtension } from "../types/index.js";

export class ParseError extends UserError {
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
  }
}

export function pluginsFor(extension: SupportedExtension): ParserPlugin[] {
  switch (extension) {
    case ".ts":
    case ".mts":
    case ".cts":
      return ["typescript"];
    case ".tsx":
      return ["typescript", "jsx"];
    default:
      return ["jsx"];
  }
}

export function parseSource(code: string, extension: SupportedExtension): File {
  try {
    return parse(code, {
      sourceType: extension === ".js" || extension === ".jsx" || extension === ".cjs" ? "unambiguous" : "module",
      plugins: pluginsFor(extension),
      errorRecovery: false,
    });
  } catch (error) {
    const loc = (error as { loc?: { line: number; column: number } }).loc;
    const reason = (error as Error).message.replace(/\s*\(\d+:\d+\)$/, "");
    throw new ParseError(
      loc ? `Syntax error at line ${loc.line}, column ${loc.column + 1}: ${reason}` : `Syntax error: ${reason}`,
      loc?.line,
      loc?.column,
    );
  }
}
