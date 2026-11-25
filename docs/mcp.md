# MCP: OpenPitStop as tools inside your coding agent

`pitstop mcp` runs OpenPitStop as a [Model Context Protocol](https://modelcontextprotocol.io/)
server over stdio. Any MCP-capable host can call OpenPitStop to understand a repository, map
its attack surface, run the quick static pass, reproduce a finding, read the benchmark, or ask
for the release verdict — without leaving the editor or the agent chat.

```bash
pitstop mcp          # stdio server; stdout carries JSON-RPC, diagnostics go to stderr
```

The server is a thin adapter over commands the CLI already ships. It does not add a second
analyzer and it does not relax a verdict.

## The independence rule

The calling agent can inspect anything and can run checks, but it cannot declare its own work
verified. `pitstop_release_gate` reads sealed evidence — the scan baseline, integrity
detectors, acceptance/holdout/regression seals, the working tree — and returns the verdict those
records support. A missing, stale or tampered baseline is reported as `FAILED`/`UNPROVEN`,
never converted into a pass. The tool description says so, and the server's `instructions`
field repeats it to the host at `initialize`.

## Tools

| Tool | What it does | Writes |
|---|---|---|
| `pitstop_understand` | Languages, frameworks, parser/analysis/verification support levels, infrastructure files, optional tool plan | nothing |
| `pitstop_map` | Attack-surface leads: candidate routes, entry points, auth/data evidence, infrastructure. `architecture: true` returns modules, dependencies, cycles, services, boundaries | nothing |
| `pitstop_scan` | Quick static pass: offline security rules, dependency graph, duplication, devex; seals the baseline | `.pitstop/` only |
| `pitstop_release_gate` | Deterministic gate over sealed layers and the working tree (`threshold`, `strict`, `require`) | nothing |
| `pitstop_reproduce` | Generate and run a failing-first repro test for a finding id | one repro test file |
| `pitstop_bench` | The published detection benchmark with denominators and limits | nothing |

Route lists and path labels are leads, not reachability proof. `pitstop_scan` does not run the
test suite or the build — a clean quick pass is not a security verdict, and the tool's own
result says so. `pitstop_reproduce` writes a test, never a source patch.

## Configure a host

The command is always the same — `pitstop mcp` (or the absolute path to the binary when the
host does not inherit your shell `PATH`). Host configuration schemas change; these are the
shapes in current use. Check your host's MCP documentation if a key has moved.

**Claude Code**

```bash
claude mcp add openpitstop -- pitstop mcp
```

or a project `.mcp.json`:

```json
{
  "mcpServers": {
    "openpitstop": { "command": "pitstop", "args": ["mcp"] }
  }
}
```

**Cursor** — `.cursor/mcp.json`, same `mcpServers` shape as above.

**VS Code / GitHub Copilot** — `.vscode/mcp.json`, which nests servers under `servers`:

```json
{
  "servers": {
    "openpitstop": { "type": "stdio", "command": "pitstop", "args": ["mcp"] }
  }
}
```

**Gemini CLI** — `~/.gemini/settings.json`, `mcpServers` key, same `command`/`args` shape.

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.openpitstop]
command = "pitstop"
args = ["mcp"]
```

**OpenCode** — `opencode.json`:

```json
{
  "mcp": {
    "openpitstop": { "type": "local", "command": ["pitstop", "mcp"] }
  }
}
```

**Kilo Code and other hosts** — any MCP client that can start a stdio server with
`command`/`args` works; use the same pair.

Restart the host after editing its configuration, then ask it to list MCP tools. If the tools
do not appear, run `pitstop mcp` by hand and confirm it prints nothing to stdout while idle
and nothing at all on stderr at startup.

## What the agent should do with them

A useful loop for the host agent:

1. `pitstop_understand` — what is this repository, and what will actually be analyzed?
2. `pitstop_scan` — seal a baseline before making changes.
3. Make the change with the host agent, as usual.
4. `pitstop_reproduce` — for a finding that should now be fixed, keep the bug from returning.
5. `pitstop_release_gate` — ask for the verdict. Read the layer list; `NOT_CONFIGURED` means
   never run, not passed.

Deep verification layers (acceptance, holdout, regression, verify-stack) are produced by the
CLI commands of the same name. The gate reports the ones that exist and never treats a missing
layer as a pass.

## Limits

- Stdio only. There is no network listener, no remote transport and no authentication layer,
  because the host owns the process boundary.
- One JSON-RPC object per line on stdout. Nothing else is written there, so a host that logs
  stderr separately can surface diagnostics safely.
- Paths given to tools resolve against the directory the server was started in; `repo` may be
  absolute or relative.
- The quick scan, map and understand calls run the same in-process analyzers as the CLI, so
  they are as fast as the relevant CLI command — not faster and not more thorough.
- The server never edits source, never installs packages, never starts your application and
  never calls a model.
