const express = require("express");
const gateway = require("./gateway");

const app = express();
app.use(express.json());

// In-memory "ledger". Deliberately has NO idempotency keying: a retried or
// replayed request results in another gateway charge. This is the bug.
const charges = new Map(); // key -> charge log
const chargeLog = (key) => {
  if (!charges.has(key)) charges.set(key, []);
  return charges.get(key);
};

/**
 * Charge an order. NO idempotency check: send the same payload + the same
 * Idempotency-Key twice and the gateway is charged twice.
 */
app.post("/api/orders/:id/charge", async (req, res) => {
  const { id } = req.params;
  const { amount, currency } = req.body || {};
  const idemKey = req.get("Idempotency-Key") || req.get("X-Idempotency-Key") || null;

  // The payment being charged is derived from the idempotency key (or order id).
  // The key is received but NEVER deduped — that is the bug under test.
  const paymentId = idemKey ? `pay_${idemKey}` : `pay_${id}`;
  const payment = await gateway.charge(paymentId, amount, currency);

  chargeLog(idemKey || id).push({
    action: "charge",
    paymentId,
    idemKey,
    at: new Date().toISOString(),
  });
  res.json({ ok: true, orderId: id, paymentId, charges: chargeLog(idemKey || id).length });
});

/**
 * Razorpay webhook. Bug: every delivered event triggers a gateway capture with
 * no dedup, so replaying the same webhook double-charges.
 */
app.post("/api/webhooks/razorpay", async (req, res) => {
  const event = req.body || {};
  const entity = event?.payload?.payment?.entity;
  if (event.event === "payment.captured" && entity) {
    await gateway.charge(entity.id, entity.amount, entity.currency);
    chargeLog(entity.id).push({
      action: "capture",
      paymentId: entity.id,
      at: new Date().toISOString(),
    });
  }
  res.json({ received: true });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 4000;
  app.listen(port, () => console.log(`pitstop-demo-fintech listening on ${port}`));
}

module.exports = app;