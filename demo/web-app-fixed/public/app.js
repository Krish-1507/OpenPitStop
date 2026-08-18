// Client script loaded by views/index.html.
// FIXED: the session travels in an httpOnly cookie set by the server, never in
// localStorage (which any XSS can read). No credential is touched here.
function loadProfile() {
  fetch("/api/account", { credentials: "include" })
    .then((r) => r.json())
    .then((u) => {
      // FIXED: textContent instead of innerHTML — no DOM XSS.
      const el = document.getElementById("profile");
      if (el) el.textContent = u.name;
    });
}

loadProfile();
