import fs from "node:fs";
import path from "node:path";
import { discoverInfrastructure } from "../languages/discovery.js";
import type { ScanIssue } from "../analyzers/types.js";

/**
 * Infrastructure security analysis.
 *
 * These are deterministic, line-anchored checks over files that the source
 * scanners deliberately skip (Docker, Compose, Terraform, Kubernetes/Helm,
 * GitHub Actions, SQL and config YAML). Every finding is `indicated`: the file
 * contains the risky construct, but runtime exposure still depends on how it
 * is deployed. No finding is emitted for placeholder or environment-expanded
 * values.
 */
interface InfraRule {
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  test: (line: string, all: string) => boolean;
  description: string;
  fix: string;
}

const DOCKER_RULES: InfraRule[] = [
  {
    category: "container-root-user",
    severity: "high",
    title: "container runs as root",
    test: (line) => /^\s*USER\s+root\s*$/i.test(line),
    description: "A container stage explicitly runs as root; a process escape or application compromise gains root inside that stage.",
    fix: "Create an unprivileged user in the image and switch with `USER app` after copying files; set `runAsNonRoot: true` in orchestration.",
  },
  {
    category: "container-secret-env",
    severity: "high",
    title: "secret-like value baked into image environment",
    test: (line) => /^\s*(?:ENV|ARG)\s+[^=]*(?:PASSWORD|SECRET|TOKEN|API[_-]?KEY)[^=]*=\s*["']?[^"'$\s]+/i.test(line),
    description: "A secret-shaped environment value is written into the image layer; anyone who can pull the image can recover it.",
    fix: "Do not bake secrets into images. Inject them at runtime from a secret manager or environment; use BuildKit secrets for build-time needs.",
  },
  {
    category: "container-remote-add",
    severity: "medium",
    title: "Docker ADD fetches a remote URL",
    test: (line) => /^\s*ADD\s+https?:\/\//i.test(line),
    description: "ADD downloads a remote artifact without an integrity check, adding a supply-chain path to the image.",
    fix: "Use a pinned checksum (`ADD --checksum=sha256:...`) or download and verify the artifact in a controlled build step.",
  },
  {
    category: "container-exposed-sensitive-port",
    severity: "low",
    title: "sensitive service port exposed in the image",
    test: (line) => /^\s*EXPOSE\s+(?:22|2375|2376|5432|3306|6379|27017)\b/i.test(line),
    description: "The image declares a sensitive management or data-store port. EXPOSE alone does not publish it, but it documents an exposure pattern worth reviewing.",
    fix: "Remove the EXPOSE entry unless the service must be reachable; restrict publishing to trusted networks and require authentication/TLS.",
  },
];

const COMPOSE_RULES: InfraRule[] = [
  {
    category: "container-privileged",
    severity: "critical",
    title: "privileged container",
    test: (line) => /^\s*privileged\s*:\s*true\b/i.test(line),
    description: "A privileged container can access host devices and escape most container isolation.",
    fix: "Remove `privileged: true`; grant only the specific capabilities the service needs with `cap_drop`/`cap_add`.",
  },
  {
    category: "container-host-network",
    severity: "high",
    title: "container shares the host network namespace",
    test: (line) => /^\s*network_mode\s*:\s*["']?host["']?\s*$/i.test(line),
    description: "Host networking removes a network isolation boundary and can expose services bound to localhost.",
    fix: "Use a dedicated container network and publish only the required ports.",
  },
  {
    category: "container-docker-socket",
    severity: "critical",
    title: "Docker socket mounted into a container",
    test: (line) => /\/var\/run\/docker\.sock/.test(line),
    description: "Mounting the Docker socket gives the container effective root control over the host daemon.",
    fix: "Do not mount the Docker socket. Use a narrowly scoped API proxy or run the operation outside the container.",
  },
  {
    category: "container-root-user",
    severity: "high",
    title: "container runs as root",
    test: (line) => /^\s*user\s*:\s*["']?(?:root|0)(?::0)?["']?\s*$/i.test(line),
    description: "The service is configured to run as root inside the container.",
    fix: "Set an unprivileged `user:` and ensure file ownership allows the service to write only where it needs to.",
  },
  {
    category: "container-secret-env",
    severity: "high",
    title: "secret-like value in Compose environment",
    test: (line) => /^\s*(?:-\s*)?[A-Z_]*(?:PASSWORD|SECRET|TOKEN|API[_-]?KEY)\s*[:=]\s*["']?[^"'$#\s]+/i.test(line),
    description: "A secret-shaped value is written directly into the Compose file, where it is committed with the deployment configuration.",
    fix: "Reference an external secret or an environment variable populated by the deployment platform; do not commit the value.",
  },
  {
    category: "container-published-data-port",
    severity: "medium",
    title: "database port published by Compose",
    test: (line) => /^\s*-\s*["']?(?:0\.0\.0\.0:)?(?:5432|3306|6379|27017|9200|2375|2376):(?:5432|3306|6379|27017|9200|2375|2376)["']?\s*$/i.test(line),
    description: "A database or management port is published from the container, potentially beyond localhost.",
    fix: "Bind to 127.0.0.1 when local access is required, or keep the database on an internal network with authentication and TLS.",
  },
];

const K8S_RULES: InfraRule[] = [
  {
    category: "kubernetes-privileged",
    severity: "critical",
    title: "privileged Kubernetes container",
    test: (line) => /^\s*privileged\s*:\s*true\b/i.test(line),
    description: "A privileged pod can access host devices and bypass container isolation.",
    fix: "Remove privileged mode; use a minimal `securityContext`, dropped capabilities, and a read-only root filesystem where possible.",
  },
  {
    category: "kubernetes-host-namespace",
    severity: "high",
    title: "pod shares a host namespace",
    test: (line) => /^\s*(?:hostNetwork|hostPID|hostIPC)\s*:\s*true\b/i.test(line),
    description: "Sharing a host namespace weakens isolation and can expose host processes or network reachability.",
    fix: "Remove host namespace sharing unless the workload is a strictly scoped system component.",
  },
  {
    category: "kubernetes-host-path",
    severity: "high",
    title: "pod mounts a host path",
    test: (line) => /^\s*(?:-\s*)?hostPath\s*:/i.test(line),
    description: "A hostPath mount can expose or modify host files and is a common container-escape aid.",
    fix: "Use a managed volume or CSI driver; if hostPath is unavoidable, restrict the path and mount it read-only.",
  },
  {
    category: "kubernetes-root-user",
    severity: "high",
    title: "pod explicitly runs as root",
    test: (line) => /^\s*runAsUser\s*:\s*0\s*$/i.test(line),
    description: "The pod explicitly selects UID 0.",
    fix: "Run as a non-root UID and set `runAsNonRoot: true`.",
  },
  {
    category: "kubernetes-privilege-escalation",
    severity: "medium",
    title: "privilege escalation allowed",
    test: (line) => /^\s*allowPrivilegeEscalation\s*:\s*true\b/i.test(line),
    description: "The container may gain more privileges than its parent process.",
    fix: "Set `allowPrivilegeEscalation: false` and drop all capabilities that are not required.",
  },
  {
    category: "kubernetes-literal-secret",
    severity: "high",
    title: "literal secret in a Kubernetes manifest",
    test: (line) => /^\s*[A-Z_]*(?:PASSWORD|SECRET|TOKEN|API[_-]?KEY)\s*:\s*["']?[^"'$#\s]+/i.test(line),
    description: "A secret-shaped value is stored in a manifest rather than referenced from a Secret.",
    fix: "Create a Kubernetes Secret through a secret manager, reference it with `secretKeyRef`, and rotate the exposed value.",
  },
  {
    category: "kubernetes-unpinned-image",
    severity: "low",
    title: "Kubernetes image is not pinned",
    test: (line) => {
      const match = /^\s*(?:-\s*)?image\s*:\s*["']?([^"'\s]+)["']?\s*$/i.exec(line);
      if (!match) return false;
      const image = match[1];
      if (/^\$\{/.test(image) || /@sha256:[0-9a-f]{32,}/i.test(image)) return false;
      const last = image.split("/").pop() ?? image;
      return /:latest$/i.test(last) || !last.includes(":");
    },
    description: "An image without an immutable tag/digest makes rollbacks and supply-chain review unreliable.",
    fix: "Pin images to an immutable digest or an exact version.",
  },
];

const TERRAFORM_RULES: InfraRule[] = [
  {
    category: "terraform-public-acl",
    severity: "critical",
    title: "Terraform resource has a public ACL",
    test: (line) => /\bacl\s*=\s*["']public-read(?:-write)?["']/i.test(line),
    description: "A public ACL exposes the resource to the internet.",
    fix: "Use a private ACL and grant access through an explicit, least-privilege policy.",
  },
  {
    category: "terraform-publicly-accessible",
    severity: "high",
    title: "Terraform resource is publicly accessible",
    test: (line) => /\bpublicly_accessible\s*=\s*true\b/i.test(line),
    description: "The resource is configured for public network access.",
    fix: "Set `publicly_accessible = false` and place the resource in a private subnet.",
  },
  {
    category: "terraform-unencrypted",
    severity: "medium",
    title: "Terraform storage encryption disabled",
    test: (line) => /\bencrypted\s*=\s*false\b/i.test(line),
    description: "Storage encryption is explicitly disabled.",
    fix: "Enable encryption at rest and manage the key through your cloud KMS.",
  },
  {
    category: "terraform-wildcard-action",
    severity: "high",
    title: "IAM policy grants a wildcard action",
    test: (line) => /\bAction\s*=\s*["']\*["']/i.test(line),
    description: "A wildcard IAM action grants far more authority than most workloads need.",
    fix: "Replace `*` with the smallest set of actions the workload actually uses; scope resources too.",
  },
];

const GITHUB_RULES: InfraRule[] = [
  {
    category: "ci-write-all",
    severity: "high",
    title: "workflow requests write-all permissions",
    test: (line) => /^\s*permissions\s*:\s*write-all\s*$/i.test(line),
    description: "The workflow grants every GitHub token permission, including repository and package writes.",
    fix: "Set explicit least-privilege permissions, e.g. `contents: read` and only the write scopes the job needs.",
  },
  {
    category: "ci-untrusted-interpolation",
    severity: "critical",
    title: "untrusted event data interpolated into a shell",
    test: (line) => /^\s*(?:-\s*)?run\s*:.*\$\{\{\s*github\.event\.(?:pull_request|issue|comment|discussion)\./i.test(line),
    description: "Attacker-controlled pull request/issue text is interpolated into a shell command, enabling script injection in the workflow.",
    fix: "Pass event data through an environment variable and quote it, or avoid using untrusted event fields in shell commands.",
  },
  {
    category: "ci-secret-echo",
    severity: "high",
    title: "workflow echoes a secret",
    test: (line) => /^\s*(?:-\s*)?run\s*:.*(?:echo|printf).*\$\{\{\s*secrets\./i.test(line),
    description: "A workflow command prints a secret into logs; GitHub masking is not a guarantee and logs can be exported.",
    fix: "Never print secrets. Pass them only to the command that needs them and mask derived values deliberately.",
  },
  {
    category: "ci-unpinned-action",
    severity: "medium",
    title: "GitHub Action uses a mutable ref",
    test: (line) => /^\s*(?:-\s*)?uses\s*:\s*[^@\s]+@(?:main|master|latest)\s*$/i.test(line),
    description: "A mutable branch or tag lets the action's publisher change the code executed by this workflow.",
    fix: "Pin third-party actions to a full commit SHA (or a reviewed major tag) and update deliberately.",
  },
  {
    category: "ci-pull-request-target",
    severity: "high",
    title: "workflow uses pull_request_target",
    test: (line) => /^\s*(?:on\s*:\s*)?pull_request_target\s*:?\s*$/i.test(line),
    description: "pull_request_target runs with the base repository's privileges and secrets; combining it with untrusted checkout content is a common privilege-escalation path.",
    fix: "Prefer `pull_request` for untrusted code. If pull_request_target is required, never execute or check out untrusted head code with write credentials.",
  },
];

const SQL_RULES: InfraRule[] = [
  {
    category: "sql-grant-all",
    severity: "high",
    title: "SQL grants all privileges",
    test: (line) => /^\s*GRANT\s+ALL\b/i.test(line),
    description: "A broad GRANT gives the principal more authority than the application needs.",
    fix: "Grant only the required verbs on the specific objects; separate migration and runtime roles.",
  },
  {
    category: "sql-literal-password",
    severity: "critical",
    title: "SQL contains a literal password",
    test: (line) => /^\s*(?:CREATE|ALTER)\s+USER\b[^;]*PASSWORD\s+['"][^'"]+['"]/i.test(line),
    description: "A database credential is written into a SQL file, where it can be committed and copied.",
    fix: "Create users through a secret manager or a parameterized migration; rotate the exposed credential.",
  },
];

const CONFIG_SECRET_RE = /^\s*(?:export\s+)?["']?(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|jwt[_-]?secret)["']?\s*[:=]\s*["']?([^"'$#\s]{4,})/i;

function isPlaceholder(value: string): boolean {
  return /^(?:changeme|change-me|example|dummy|test|todo|your[-_ ].*|x{4,}|0{4,}|\*{4,}|<.*>|\$\{.*\}|true|false|null|none|enabled|disabled|on|off)$/i.test(value);
}

function finding(
  repo: string,
  file: string,
  line: number,
  category: string,
  severity: "critical" | "high" | "medium" | "low",
  title: string,
  description: string,
  fix: string,
): ScanIssue {
  return {
    type: "infrastructure",
    category,
    severity,
    title,
    file: path.relative(repo, file).replace(/\\/g, "/"),
    line,
    description: `[indicated] ${description}`,
    fix,
    sourceTool: "pitstop-infrastructure",
    confidence: "indicated",
    reachability: "unknown",
    reproduction: `Open ${path.relative(repo, file).replace(/\\/g, "/")}:${line} and compare it with the deployment configuration.`,
  };
}

function scanRules(
  repo: string,
  file: string,
  rules: InfraRule[],
  out: ScanIssue[],
  options: { skipComments?: boolean } = {},
): void {
  let content: string;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 2_000_000) return;
    content = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const lines = content.split(/\r?\n/);
  for (const rule of rules) {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (options.skipComments && /^\s*#/.test(line)) continue;
      if (!rule.test(line, content)) continue;
      out.push(finding(repo, file, index + 1, rule.category, rule.severity, rule.title, rule.description, rule.fix));
      break;
    }
  }
}

/** Docker base image checks need stage aliases (`FROM build AS base`) to avoid false positives. */
function scanDockerBaseImages(repo: string, file: string, out: ScanIssue[]): void {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const lines = content.split(/\r?\n/);
  const aliases = new Set<string>();
  for (const line of lines) {
    const m = /^\s*FROM\s+\S+\s+AS\s+(\S+)\s*$/i.exec(line);
    if (m) aliases.add(m[1].toLowerCase());
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (!m) continue;
    const image = m[1];
    const lower = image.toLowerCase();
    if (lower === "scratch" || /^\$\{?\w+\}?$/.test(image) || aliases.has(lower)) continue;
    if (/@sha256:[0-9a-f]{32,}/i.test(image)) continue;
    const last = image.split("/").pop() ?? image;
    const pinned = last.includes(":") && !/:latest$/i.test(last);
    if (pinned) continue;
    out.push(finding(
      repo, file, index + 1, "container-base-latest", "low",
      "base image is not pinned",
      "A floating base image makes builds non-reproducible and can silently pull a changed or compromised image.",
      "Pin the base image to a digest or an exact version and update it deliberately.",
    ));
  }
}

/** Terraform ingress must be read as a block; a port elsewhere in the file is not evidence. */
function scanTerraformIngress(repo: string, file: string, out: ScanIssue[]): void {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*(?:ingress\s*\{|resource\s+["'][^"']*security_group[^"']*["']\s+["'][^"']+["']\s*\{)/i.test(lines[index])) continue;
    let depth = 0;
    const block: { line: number; text: string }[] = [];
    for (let i = index; i < lines.length; i++) {
      const line = lines[i];
      block.push({ line: i + 1, text: line });
      depth += (line.match(/{/g) ?? []).length;
      depth -= (line.match(/}/g) ?? []).length;
      if (depth <= 0) break;
    }
    const blockText = block.map((entry) => entry.text).join("\n");
    const publicCidr = block.find((entry) => /["']0\.0\.0\.0\/0["']/.test(entry.text));
    const sensitivePort = /\b(?:from_port|to_port|port)\s*=\s*(?:22|3389|5432|3306|6379|27017)\b/i.test(blockText);
    if (publicCidr && sensitivePort) {
      out.push(finding(
        repo, file, publicCidr.line, "terraform-open-ingress", "high",
        "security group allows the internet",
        "A security group ingress rule allows 0.0.0.0/0 to a sensitive management or database port.",
        "Restrict the CIDR to trusted networks or a bastion/VPN range, and require authentication and TLS.",
      ));
    }
    index += block.length - 1;
  }
}

const GENERATED_LOCKFILE = /(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|composer\.lock|Pipfile\.lock|poetry\.lock)$/i;

function scanConfigSecrets(repo: string, file: string, out: ScanIssue[]): void {
  if (GENERATED_LOCKFILE.test(file)) return;
  let content: string;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 2_000_000) return;
    content = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = CONFIG_SECRET_RE.exec(lines[index]);
    if (!match || isPlaceholder(match[1])) continue;
    out.push(finding(
      repo, file, index + 1, "config-literal-secret", "high",
      "literal secret in configuration",
      "A secret-shaped value is stored directly in a configuration file; anyone with the file can use it.",
      "Move the value to a secret manager or environment injection, rotate it, and commit only a placeholder/example.",
    ));
  }
}

/** Analyze infrastructure/config files and return scanner-independent issues. */
export function analyzeInfrastructure(repo: string): ScanIssue[] {
  const out: ScanIssue[] = [];
  let infrastructure: ReturnType<typeof discoverInfrastructure>;
  try {
    infrastructure = discoverInfrastructure(path.resolve(repo));
  } catch {
    return out;
  }

  const specialized = new Set<string>();
  for (const item of infrastructure) {
    for (const relative of item.files) {
      const file = path.resolve(repo, relative);
      const base = path.basename(file).toLowerCase();
      if (item.id === "docker") {
        specialized.add(file);
        if (base === "dockerfile" || base.startsWith("dockerfile.")) {
          scanRules(repo, file, DOCKER_RULES, out, { skipComments: true });
          scanDockerBaseImages(repo, file, out);
        } else {
          scanRules(repo, file, COMPOSE_RULES, out, { skipComments: true });
        }
      } else if (item.id === "terraform") {
        specialized.add(file);
        scanRules(repo, file, TERRAFORM_RULES, out, { skipComments: true });
        scanTerraformIngress(repo, file, out);
      } else if (item.id === "kubernetes" || item.id === "helm") {
        specialized.add(file);
        scanRules(repo, file, K8S_RULES, out, { skipComments: true });
      } else if (item.id === "github-actions") {
        specialized.add(file);
        scanRules(repo, file, GITHUB_RULES, out, { skipComments: true });
        // A workflow env block can carry a literal secret; this category does
        // not overlap with the GitHub-specific rules above.
        scanConfigSecrets(repo, file, out);
      } else if (item.id === "sql") {
        specialized.add(file);
        scanRules(repo, file, SQL_RULES, out, { skipComments: true });
      } else if (item.id === "yaml" || item.id === "json") {
        if (!specialized.has(file)) scanConfigSecrets(repo, file, out);
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((issue) => {
    const key = `${issue.category}|${issue.file}|${issue.line ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
