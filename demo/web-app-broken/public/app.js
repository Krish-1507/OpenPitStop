// Client script loaded by views/index.html.
// BUG: session token stored in localStorage — readable by any XSS.
const token = "fake-jwt";
localStorage.setItem("token", token);

function loadProfile() {
  const t = localStorage.getItem("token");
  fetch("/api/account", { headers: { Authorization: `Bearer ${t}` } })
    .then((r) => r.json())
    .then((u) => {
      // BUG: untrusted field dropped into the DOM via innerHTML (XSS).
      document.getElementById("profile").innerHTML = `<div>${u.name}</div>`;
    });
}

loadProfile();
