export function showNotice(el, req) {
  el.innerHTML = req.query.notice;
}
