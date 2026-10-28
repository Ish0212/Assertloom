export const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

export type SourceLanguage = "typescript" | "javascript";

export interface SourceFile {
  /** Path as the user typed it, normalized for display. */
  inputPath: string;
  absolutePath: string;
  extension: SupportedExtension;
  language: SourceLanguage;
  sizeBytes: number;
}
