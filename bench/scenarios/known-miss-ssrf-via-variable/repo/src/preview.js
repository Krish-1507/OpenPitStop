export async function fetchPreview(req) {
  const url = req.query.url;
  return fetch(url);
}
