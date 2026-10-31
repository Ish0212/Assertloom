/** Sum of price × quantity for every line, in cents. */
export function subtotal(lines) {
  return lines.reduce((total, line) => {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new RangeError(`Invalid quantity for ${line.sku}: ${line.quantity}`);
    }
    return total + line.priceCents * line.quantity;
  }, 0);
}

const CODES = {
  SAVE10: { kind: "percent", value: 10 },
  FIVEOFF: { kind: "fixed", value: 500 },
};

/** Applies a discount code. Totals never go below zero. Unknown codes throw. */
export function applyDiscount(totalCents, code) {
  if (!code) return totalCents;
  const discount = CODES[code.trim().toUpperCase()];
  if (!discount) throw new Error(`Unknown discount code: ${code}`);
  const off = discount.kind === "percent" ? Math.round((totalCents * discount.value) / 100) : discount.value;
  return Math.max(0, totalCents - off);
}

/** Formats cents as a currency string, for example 1999 → "$19.99". */
export function formatPrice(cents, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
