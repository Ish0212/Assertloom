export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function truncate(text: string, maxLength: number, suffix = "..."): string {
  if (maxLength < suffix.length) throw new RangeError("maxLength must be at least the suffix length");
  return text.length <= maxLength ? text : text.slice(0, maxLength - suffix.length) + suffix;
}

export function isPalindrome(text: string): boolean {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned === [...cleaned].reverse().join("");
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) throw new Error("size must be a positive integer");
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export function parseDuration(input: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(input.trim());
  if (!match) throw new Error(`Invalid duration: ${input}`);
  const units = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
  return Number(match[1]) * units[match[2] as keyof typeof units];
}

export async function retryAsync<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
