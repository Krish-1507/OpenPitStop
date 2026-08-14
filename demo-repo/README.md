# pitstop-demo-api

> **This is OpenPitStop's intentionally-broken demo repository.** Do not use it as a
> real application. It is seeded with genuine, detectable problems so you can watch
> `pitstop` scan, pause for confirmation, then autonomously fix and verify in a loop.

Seeded problems (so you can check the numbers in `PITSTOP_REPORT.md`):

- **Circular dependencies** between `userRepo` ↔ `userService` ↔ `userController` (a real
  3-module import cycle).
- **Hardcoded secret** in `src/config.js` (a fake AWS-style key + DB password) — `gitleaks`
  flags it when installed.
- **Outdated dependency with a known CVE**: `lodash@4.17.15` (CVE-2021-23337). `npm audit`
  flags it.
- **Copy-pasted block** duplicated across `src/userService.js` and `src/userController.js`
  — `jscpd` flags it when installed.
- **2 failing unit tests** in `test/user.test.js` (assert correct behavior; the implementation
  is buggy on purpose).
- **N+1 query pattern** spanning `userController` → `userService` → `userRepo` (the service
  loops users and queries posts per-user). Phase 2's clustering groups these three files into
  one root-cause cluster.

Run it: `pitstop demo` copies this into a temp dir, installs the slash command, and tells you
where to open it.
