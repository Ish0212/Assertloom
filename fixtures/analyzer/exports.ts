export type Handler = (x: number) => number;

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

const slugify = (text: string): string => normalize(text).replace(/\s+/g, "-");

function internalOnly(): number {
  return 42;
}

export function parse(input: string): number;
export function parse(input: number): number;
export function parse(input: string | number): number {
  return Number(input);
}

export declare function provided(x: number): void;

export const VERSION = "1.0.0";

export const double = ((x: number) => x * 2) satisfies Handler;

export { normalize, slugify as toSlug };
export default slugify;
