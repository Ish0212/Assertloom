const db = require("./db.cjs");
const { formatCents } = require("./money.cjs");

async function customerTotal(customerId) {
  const rows = await db.query("SELECT amount_cents FROM orders WHERE customer_id = $1", [customerId]);
  const cents = rows.reduce((sum, row) => sum + row.amount_cents, 0);
  return formatCents(cents);
}

module.exports = { customerTotal };
