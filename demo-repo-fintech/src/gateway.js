// Payment-gateway wrapper around the official razorpay Node SDK.
// All outbound calls go through the SDK's HTTP client (axios -> https), so
// OpenPitStop's ledger sandbox (nock) can intercept them before they leave the
// process. In ledger mode the gateway is always a mock — never the real one.
const Razorpay = require("razorpay");

// Fake credentials are fine: requests are intercepted by nock in ledger mode
// and never actually reach razorpay.
const KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_pitstop000000";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "pitstop_fake_secret";

const instance = new Razorpay({
  key_id: KEY_ID,
  key_secret: KEY_SECRET,
});

/**
 * Charge a payment. This is THE money-moving call: it captures an authorized
 * payment at the gateway. Every invocation produces one gateway charge.
 */
async function charge(paymentId, amount, currency) {
  const res = await instance.payments.capture(paymentId, amount, currency);
  return res;
}

module.exports = { charge, KEY_ID };