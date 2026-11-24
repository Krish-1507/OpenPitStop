const ALLOWED_ORIGINS = new Set(["https://api.example.com"]);

export async function fetchPreview(req) {
  const target = new URL(req.query.url);
  if (!ALLOWED_ORIGINS.has(target.origin)) {
    throw new Error("destination not allowed");
  }
  const safeUrl = target.href;
  return fetch(safeUrl);
}
