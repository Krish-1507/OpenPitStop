export async function fetchPreview(req) {
  return fetch(req.query.url);
}
