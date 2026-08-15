# OpenPitStop Privacy Statement

**Zero telemetry. Zero SaaS. Zero accounts. Nothing leaves your machine unless
you explicitly ask for it.**

This is not a marketing sentence — it is a guarantee you can verify. OpenPitStop
is a local CLI: it reads files on your machine, writes reports to
`.pitstop/` on your machine, and makes network calls only in the exact,
explicit cases listed below.

## What OpenPitStop never does

- **No telemetry.** No analytics SDK, no anonymous usage stats, no crash
  reporting, no "phone home" of any kind — not even a version check.
- **No SaaS, no accounts, no cloud.** There is no OpenPitStop server, no
  dashboard, no login. Nothing to sign up for.
- **No code uploads.** `scan`, `try`, `verify`, `gate`, `integrity`, `pen`,
  `ledger`, `watch`, `trends`, `digest`, `share`, `honesty` — every one of
  these analyzes your files locally. Your source never leaves your machine.
- **No third-party processes** are ever spawned that you didn't initiate
  (`scan` runs the scanners you have installed, e.g. `gitleaks`, `semgrep`,
  `osv-scanner`, `pip-audit` — or honestly reports them as `skipped`).
- **The static security pass is fully offline.** It reads files and matches
  patterns on your machine; it never sends code anywhere. The only network
  calls in the entire security pipeline are the dependency audits listed
  below.
- **No auto-updates.** The CLI never updates itself or checks for updates.
  You control when you run a newer version (`npx openpitstop@latest`).

## The complete list of network calls

Every outbound connection OpenPitStop (or the tools it invokes) can make:

| When | What connects | What it sends | Where it goes |
|---|---|---|---|
| You run `npx openpitstop` or `npm i -g openpitstop` | npm client | package download (standard npm request) | registry.npmjs.org |
| `scan`/`try` — security category on a JS repo | `npm audit` | your lockfile's dependency list (the standard npm audit payload) | registry.npmjs.org |
| `scan`/`try` — security category on Python repos | `pip-audit` (if installed) | dependency list | its configured index |
| `scan`/`try` — security category on other stacks | `osv-scanner` (if installed) | manifest/lockfile data | the OSV API (osv.dev) |
| `pen` / `scan --ledger` | *nothing external* | — | none |

Everything else — including the entire `pen` and `ledger` dynamic phases — runs
against **your own app on localhost**: outbound HTTP is intercepted in-process
(nock) or rerouted to a local recording proxy, raw sockets are blocked, and
known payment-gateway hosts are answered with mocked receipts. If a request
cannot be intercepted, the run **aborts** (`exit 77`) rather than letting it
through. Nothing your app says ever reaches a real payment gateway or any real
third party.

Audit results (`npm audit`, `osv-scanner`) are cached locally for 24 hours
(keyed on your lockfile's hash) so repeated scans inside one fix loop don't hit
the registry again — the cache is a local file, deleted when you delete it.

## What OpenPitStop stores

All local, all in your repo:

- `.pitstop/` — sealed scan/verify/pen/ledger evidence, audit caches, memory
  notes. Human-readable JSON, signed with a `sha256` fingerprint so the files
  are tamper-evident (and so *you* can detect any tampering).
- `PITSTOP_REPORT.md`, `PITSTOP_PEN_REPORT.md`, `PITSTOP_BADGE.svg`,
  `PITSTOP_CARD.html` — the reports you explicitly asked for.
- `PITSTOP_BADGE.json` — only with `report --badge-json`; it contains the
  score, nothing else.

Nothing is written outside your project except the `/pitstop` slash-command
files that `pitstop install` places in your AI tool's own config directories —
and `install --uninstall` removes exactly those files and nothing else.

## How to verify all of this

1. **Read the source.** The CLI is fully open (MIT). The network surface is
   small and greppable: `npm audit`, `osv-scanner`, `pip-audit`, and the
   localhost-only sandbox in `src/sandbox/` are the entire surface.
2. **Watch it with a firewall.** Run `npx openpitstop scan` with your
   firewall in "ask" mode: the only connections you'll be asked about are the
   npm/osv audits above — and none at all during `pen` or `ledger`.
3. **Disconnect.** `scan`, `verify`, `gate`, `integrity`, `pen`, `ledger`
   (ledger replays against your app locally) all run fully offline. Only the
   dependency-audit categories degrade (to an honest `skipped` with a hint) —
   they never block or fake anything.

## The short version

> OpenPitStop is a referee that lives on your machine. It keeps score in your
> repo, ships no data anywhere, and calls out any network at all — because the
> whole point is that the numbers can't be argued with. If we ever needed a
> server, the honesty brand would die with it; so we won't.
