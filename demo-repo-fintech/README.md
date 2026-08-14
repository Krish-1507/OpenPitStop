# pitstop-demo-fintech

> **This is OpenPitStop's intentionally-broken *fintech* demo repository.** It is the
> companion fixture for `pitstop scan --ledger`, whose job is to prove a **real
> double-charge** exists (not a simulated one).

## What's broken (on purpose)

- `POST /api/orders/:id/charge` — takes `amount`/`currency` and an optional
  `Idempotency-Key` header, forwards a real charge to the (mocked) `razorpay`
  gateway… but **never dedupes on the idempotency key**. Fire the same key twice
  and the gateway is charged twice.
- `POST /api/webhooks/razorpay` — on every `payment.captured` event it captures
  the payment through the gateway with **no dedup**. Replay the same webhook and
  the gateway is captured twice.

## Safety

`pitstop scan --ledger` runs this app under a `nock` sandbox that intercepts
*every* outbound HTTP request before it leaves the process. The `razorpay`
requests land on a local mock and **never** reach a real payment gateway.

Run it (from the repo root):

```
node dist/cli.js scan demo-repo-fintech --ledger
```