function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function showNotice(el, req) {
  el.innerHTML = escapeHtml(req.query.notice);
}
