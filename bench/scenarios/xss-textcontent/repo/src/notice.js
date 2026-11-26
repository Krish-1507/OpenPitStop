export function showNotice(el, req) {
  el.textContent = req.query.notice;
}
