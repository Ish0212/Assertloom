export function add(a: number, b: number): number {
  return a + b;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error("Cannot divide by zero");
  return a / b;
}

export const multiply = (a: number, b: number): number => a * b;

export const subtract = function (a: number, b: number) {
  return a - b;
};

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
};

export function* range(start: number, end: number, step = 1): Generator<number> {
  for (let i = start; i < end; i += step) yield i;
}

export function sum(...values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function greet(name: string, greeting: string = "Hello", punctuation?: string): string {
  return `${greeting}, ${name}${punctuation ?? "!"}`;
}

export function formatUser({ first, last }: { first: string; last: string }): string {
  return `${last}, ${first}`;
}

export function head<T>([first]: T[]): T | undefined {
  return first;
}

export function identity<T>(value: T): T {
  return value;
}

export function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

export function validateAll(items: string[]): boolean {
  return items.every((item) => {
    if (!item) throw new Error("Empty item");
    return true;
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export default function (input: string): string {
  return clamp(input.length, 0, 10) > 0 ? input.trim() : "";
}
