import { stat } from "node:fs/promises";
import path from "node:path";
import { SUPPORTED_EXTENSIONS, type SourceFile, type SupportedExtension } from "../types/index.js";

export class FileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileValidationError";
  }
}

const MAX_FILE_SIZE_BYTES = 1024 * 1024;

function isSupportedExtension(ext: string): ext is SupportedExtension {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext);
}

export async function validateSourceFile(inputPath: string, cwd = process.cwd()): Promise<SourceFile> {
  const absolutePath = path.resolve(cwd, inputPath);
  const displayPath = path.relative(cwd, absolutePath) || inputPath;

  const extension = path.extname(absolutePath).toLowerCase();
  if (!isSupportedExtension(extension)) {
    throw new FileValidationError(
      `Unsupported file type "${extension || "(none)"}" for ${displayPath}. ` +
        `Supported extensions: ${SUPPORTED_EXTENSIONS.join(", ")}`,
    );
  }

  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(absolutePath)) {
    throw new FileValidationError(`${displayPath} looks like a test file. Point Assertloom at source code instead.`);
  }

  let stats;
  try {
    stats = await stat(absolutePath);
  } catch {
    throw new FileValidationError(`File not found: ${displayPath}`);
  }

  if (!stats.isFile()) {
    throw new FileValidationError(`Not a file: ${displayPath}`);
  }

  if (stats.size > MAX_FILE_SIZE_BYTES) {
    throw new FileValidationError(
      `${displayPath} is ${(stats.size / 1024).toFixed(0)} KB; files larger than 1 MB are not supported.`,
    );
  }

  return {
    inputPath: displayPath,
    absolutePath,
    extension,
    language: /^\.[cm]?tsx?$/.test(extension) ? "typescript" : "javascript",
    sizeBytes: stats.size,
  };
}
