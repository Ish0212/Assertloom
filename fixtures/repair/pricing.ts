export function applyDiscount(price: number, percent: number): number {
  if (percent < 0 || percent > 100) throw new RangeError("percent must be between 0 and 100");
  return Math.round(price * (1 - percent / 100) * 100) / 100;
}

export function formatPrice(cents: number, currency = "USD"): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

export function parseQuantity(input: string): number {
  const value = Number.parseInt(input, 10);
  if (Number.isNaN(value)) throw new Error(`Invalid quantity: ${input}`);
  return value;
}

/** Average of the values; 0 for an empty list. */
export function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function slowDouble(n: number): Promise<number> {
  await Promise.resolve();
  return n * 2;
}

export async function fetchRate(currency: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:9/rates/${currency}`);
  const data = (await response.json()) as { rate: number };
  return data.rate;
}
