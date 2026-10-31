const API = "https://api.example.com/rates";

/** Fetches the exchange rate from one currency to another. */
export async function getRate(from, to) {
  const response = await fetch(`${API}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  if (!response.ok) throw new Error(`Rate request failed with status ${response.status}`);
  const body = await response.json();
  if (typeof body.rate !== "number") throw new Error(`No rate for ${from} → ${to}`);
  return body.rate;
}

/** Converts an amount in cents, rounding to the nearest cent. Same-currency conversions skip the request. */
export async function convert(cents, from, to) {
  if (from === to) return cents;
  const rate = await getRate(from, to);
  return Math.round(cents * rate);
}
