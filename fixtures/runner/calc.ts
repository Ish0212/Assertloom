export function add(a: number, b: number): number {
  return a + b;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error("Cannot divide by zero");
  return a / b;
}

export function sign(n: number): "positive" | "negative" | "zero" {
  if (n > 0) return "positive";
  if (n < 0) return "negative";
  return "zero";
}
