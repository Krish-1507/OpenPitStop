export function createOrder(req) {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
    return { error: "invalid amount" };
  }
  return { amount };
}
