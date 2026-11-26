# Architecture and change impact

`pitstop map --architecture` and `pitstop impact` answer two questions a senior
engineer asks before touching code: *what is the shape of this system?* and *what
else does this change touch?* Both read the checkout only — no model, no network, no
generated diagram. Everything they print is derived from files, imports, manifests and
the rules your repository declared.

They order the review. They do not prove reachability, coverage or exploitability;
each report ends with the limits it operated under.

## Map the architecture

```bash
pitstop map --architecture            # the architecture view
pitstop map --architecture --json     # the same evidence, machine-readable
```

The view contains, and labels, each relation by what actually proves it:

| Section | Evidence |
|---|---|
| Modules | Files grouped by path (`src/<area>`, `lib/<area>`, …), file counts, cross-module inbound/outbound import counts, role from `pitstop understand` |
| Dependencies | Aggregated imports between modules. Imports inside one module are not listed — they are not a boundary crossing |
| Cycles | Circular import chains from the file graph, listed as the actual file path |
| Routes | HTTP route registrations parsed from source (leads, not live endpoints) |
| Entry points | From `understand` plus the language analysis |
| External services | Services named by declared dependencies (manifests), not observed traffic |
| Data relationships | `prisma/schema.prisma`, SQL `REFERENCES` and ORM declarations (not live queries) |
| Data flows | Route file → data-access file along import edges (an import path, not a runtime trace) |
| Boundaries | Your declared rules and every edge that violates them |

Module grouping is deliberately boring: `moduleOf("src/auth/login.ts")` is `src/auth`,
`moduleOf("pkg/index.js")` is `pkg`, and a top-level file is its own module. The point is
a stable unit you can reason about between runs, not a perfect decomposition.

### Declared boundaries

```json
{
  "boundaries": [
    {
      "from": "src/api/**",
      "forbidImportsFrom": ["src/db/**"],
      "reason": "api must not read storage directly"
    }
  ],
  "protected": [{ "path": "src/core/**", "reason": "shared core, platform review required" }],
  "forbidden": [{ "path": "src/legacy/**", "reason": "scheduled for removal" }]
}
```

Configuration lives in `openpitstop.architecture.json` or `.pitstop/architecture.json`.
No configuration means no boundary conclusion — the report says so instead of implying
the architecture is clean. The same rules drive `architecture-check`, change impact and
the `architecture` gate layer.

## Change impact

```bash
pitstop impact                         # the working tree (and untracked files) against HEAD
pitstop impact --base origin/main      # a branch against a base ref
pitstop impact --to HEAD~5             # two refs instead of the working tree
pitstop impact --changed src/core/x.ts # analyze a file without a diff (repeatable)
pitstop impact --depth 4 --json        # bounded traversal, machine-readable
```

Impact walks the **reverse** import graph breadth-first from the changed files:

- **Dependents** — every file that imports a changed file, with its hop distance and the
  closest importer (`via`), so a transitive hit is auditable rather than a bare list.
  Distance 1 is "imports it directly"; anything further is a chain you can trace.
- **Affected modules** — the modules those dependents belong to.
- **Routes at risk** — routes defined in any affected file, flagged `sensitive` when the
  path looks privileged or authenticated.
- **Tests to run** — test files that import an affected file (by import edge) or share a
  name with a changed file (`login.ts` ↔ `login.test.ts`, `test_login.py`, `login_test.go`).
- **Architecture constraints** — declared boundary, protected and forbidden rules that
  match the changed files, with their reason.
- **Recommended checks** — the order to run them, and why each one is there:
  `architecture-check --against-plan` → `verify-stack` → `test` → `pen --static` (when
  routes are affected) → `regression-check` (when dependents exist) → `gate --strict`
  with the matching layers.

The summary box classifies breadth: `contained` (no dependents), `local` (up to five) or
`wide`. The message it carries is the point of the command: a green suite on the changed
files is not evidence about their dependents.

## Planning with impact

```bash
pitstop plan --goal "add session rotation" \
  --step "rotate on login" --step "revoke old sessions" \
  --path src/auth/ --path test/auth/
```

`plan` is a sealed contract: `architecture-check --against-plan` detects scope creep by
comparing the files the agent actually changed against `expectedPaths`. Two additions
make that contract informed rather than ceremonial:

- **Verification is derived when you omit it.** With no `--verify-command`, the plan uses
  the repository's own commands from `understand` (test, typecheck, lint, build — in that
  order, deduplicated). Passing `--verify-command` still wins.
- **The plan records the impact it was written against.** Concrete paths and directories
  are expanded to the files they contain, the impact is computed, and a compact summary
  (dependents, direct dependents, modules, routes, tests, constraints, recommended checks)
  is sealed inside `plan-latest.json`. Globs and paths that do not exist yet are skipped —
  a new file has no importers to find.

`pitstop plan --show` prints that recorded impact next to the current scope check, so a
reviewer can see what the author knew before the first edit and whether the diff stayed
inside the plan.

## Putting it together

```bash
pitstop understand                                 # languages, scripts, commands, ownership
pitstop map --architecture                         # modules, cycles, boundaries
pitstop plan --goal "…" --path src/auth/           # sealed plan + impact at planning time
# … make the change …
pitstop impact                                     # what else the diff reaches
pitstop verify-stack && pitstop test               # the repository's own verification
pitstop regression-check                           # check-level baseline vs candidate
pitstop pen --static                               # security leads in the affected paths
pitstop architecture-check --against-plan          # scope, boundaries, protected paths
pitstop gate --strict --require stack,architecture,regression,security
```

## Honest limits

- Import graphs cover JS/TS and Python. On any other stack `impact` reports that
  dependents were **not discovered** — never that there are none.
- Edges are resolved relative imports. Dynamic `require`, string-built specifiers,
  cross-language calls and runtime wiring are invisible.
- A dependent imports a changed file; that does not prove the changed line executes.
  Dependents are review order and regression surface, not a call graph.
- A matched test imports or shares a name — it does not prove coverage of the behavior.
- Routes and data relationships are parsed patterns and schema declarations, not live
  endpoints or observed queries.
- Deleted files are absent from the current graph, so their former importers are not
  inferred.
- Boundaries and protected paths are only as complete as the configuration; an empty
  config yields no boundary conclusion.
- `impact` and `plan` execute nothing. The verification commands they recommend are the
  same local evidence the rest of PitStop seals.
