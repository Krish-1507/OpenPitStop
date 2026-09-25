# Execution, evidence and spending controls

OpenPitStop 1.10.0 makes three controls part of normal execution.

## Candidate-bound evidence

Verification captures an identity **before** executing the check. Sealed gate layers
carry that identity through persistence. `gate` and `explain` compare it with the
current repository before accepting a historical pass. The identity includes:

- Real repository path, content/path/mode snapshot and Git HEAD/dirty state.
- Architecture policy, current plan and acceptance pin in `.pitstop`.
- PitStop implementation, runtime templates, package metadata, Node and platform.
- Hashed PitStop environment settings and Node execution settings.

The gate also checks external acceptance contract and holdout suite hashes. Results
from committed worktrees only authorize that exact clean candidate. A legacy artifact
without an identity, a changed candidate, unreadable inputs, or a failed fingerprint
becomes `UNPROVEN`. Existing failures and tampering remain blocking. The live scan
used by the gate has the same before-execution identity, so a check that edits its
own inputs cannot silently authorize the resulting state.

Generated outputs and dependency directories follow the documented scan snapshot
exclusions. Reinstalling tools/dependencies or changing remote services requires a
fresh run: source identity does not attest to every external dependency or service.
Digests are tamper-evident content checks, not authenticated signatures. An agent with
write access can recompute a digest. Use protected CI for release authority.

## OS-isolated live security

Prepare Docker with Linux containers and a local runtime image once:

```bash
docker pull node:22-bookworm-slim
pitstop ask "attack my app" --execute
```

Live pen, payment ledger and generated live-attack repros use the same container
runner. There is no host-execution fallback. Missing Docker/image/runtime dependencies
abort the check. A static search remains available without Docker:

```text
/pitstop find vulnerabilities in this repo
```

The container uses `--network=none`, read-only root/input mounts, UID/GID 1000, dropped
capabilities, no privilege escalation, and limits of 128 processes, two CPUs, 1 GiB
memory and three minutes per invocation. Writable app state lives on temporary memory
filesystems. The container is forcibly removed on completion or timeout.

Only a staged copy is mounted. The real repository, home directory and Docker socket
are not exposed. `.git`, `.env*`, common credential directories/files, private key
extensions and original `.pitstop` artifacts are omitted. Source-embedded credentials
are still source: staging is not a general secret detector. External symlinks, cycles
and oversized inputs fail closed. Host environment values are not forwarded; an
explicit `PITSTOP_START` command is passed as configuration. The worker supplies test
payment credentials and loopback communication for the app and mock gateway.

The default image supports Node. Dependencies copied from the repository must run on
Linux; offline execution cannot install packages. For other stacks, prepare a trusted
image containing Node plus the app runtime and dependencies, then set
`PITSTOP_SANDBOX_IMAGE` to its local tag or digest. Images are never pulled implicitly.
The preload/proxy records attack evidence inside the container. Proxy-only stacks can
have weaker observation coverage even though the OS network policy still applies.

Containers share a host kernel. This control contains normal socket, subprocess and
filesystem bypasses; it does not claim immunity to Docker/kernel vulnerabilities or
prove that the app cannot interfere with a verifier running under the same UID.
Ordinary repository tests, builds and acceptance commands retain their own documented
execution behavior; this runner specifically covers live security testing.

The Linux CI isolation job runs real raw TCP/UDP and child-process bypass attempts,
checks credential/mount boundaries, and boots the actual pen worker. It fails if Docker
or the image is unavailable. Windows unit tests check policy construction and staging;
they do not substitute for that live integration job.

## One budget for the entire external-agent loop

```bash
pitstop drive --max-agent-calls 3 --max-seconds 600 --max-prompt-chars 48000
pitstop drive --agent 'claude -p "{prompt}"' --max-cost-usd 1
pitstop budget
```

The defaults are three total launches, ten minutes and 48,000 prompt characters for
one drive session. Every finding and retry uses the same allowance. Failed launches
consume their reservation. A timeout terminates the launched process tree; repeated
identical failed verification and nonzero agent exits stop retries. Prompts are passed
as argv data, with support for quoted executable paths. Concurrent sessions in one
repository and nested PitStop drive sessions are refused. A new explicit drive command
starts a new allowance; these are session limits, not an account-wide spending policy.

Reservations are recorded in `.pitstop/agent-budget-latest.json`. `drive.lock` prevents
concurrent loops; after an interrupted process, inspect its PID before removing a
stale lock. Actual provider tokens and cost remain `null`, not guessed values. The
prompt limit covers text PitStop sends, not context the external agent reads itself.

`--max-cost-usd` divides one ceiling conservatively across the maximum allowed launches
using Claude print mode's native `--max-budget-usd`. Unused allocation is not recycled.
Claude 2.1.217+ is required for its documented subagent enforcement. Other providers
refuse a requested dollar ceiling before launching; their call/time/prompt limits
still work. Provider billing and native cap semantics remain the provider's authority.
PitStop cannot impose an account-wide dollar limit on unrelated processes or work a
provider continues remotely after a client disconnects.

Sources: [Docker execution controls](https://docs.docker.com/engine/containers/run/),
[Claude CLI budget semantics](https://code.claude.com/docs/en/cli-reference#flags).
