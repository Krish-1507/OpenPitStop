import fs from "node:fs";
import path from "node:path";
import { analyzeLanguages } from "../languages/index.js";
import { buildAttackSurface, type AttackRoute } from "../languages/map.js";
import { buildEdges, findCycles } from "../analyzers/dependencyGraph.js";
import { walkFiles } from "../analyzers/util.js";
import { LANGUAGE_ADAPTERS } from "../languages/adapters.js";
import { buildUnderstanding, globMatches, type RepoUnderstanding } from "../understand/index.js";

/**
 * Architecture mapping is evidence from the repository, not a generated
 * diagram. It combines the file dependency graph, parsed route inventory,
 * declared infrastructure/config boundaries and declared dependency manifests.
 *
 * Every relation is labeled by what proves it:
 *   - imports: resolved relative imports (JS/TS/Python only)
 *   - routes: parsed/lead-level route registrations
 *   - relationships: schema/ORM declarations, not runtime queries
 *   - external services: declared dependencies, not observed traffic
 *   - boundaries: rules the repository itself declared
 */

export interface ArchitectureModule {
  path: string;
  role: string;
  files: number;
  inbound: number;
  outbound: number;
}

export interface ArchitectureDependency {
  from: string;
  to: string;
  imports: number;
}

export interface ArchitectureBoundaryViolation {
  from: string;
  to: string;
  rule: string;
  target: string;
  reason?: string;
}

export interface ArchitectureRelationship {
  from: string;
  to: string;
  kind: "relation" | "foreign-key" | "index";
  file: string;
  line: number;
  confidence: "indicated";
}

export interface ArchitectureFlow {
  from: string;
  to: string;
  via: string;
  confidence: "indicated";
}

export interface ExternalService {
  id: string;
  displayName: string;
  evidence: string[];
  files: string[];
}

export interface ArchitectureMap {
  repo: string;
  generatedAt: string;
  engine: string | null;
  modules: ArchitectureModule[];
  dependencies: ArchitectureDependency[];
  cycles: string[][];
  routes: AttackRoute[];
  entryPoints: string[];
  externalServices: ExternalService[];
  dataRelationships: ArchitectureRelationship[];
  dataFlows: ArchitectureFlow[];
  boundaries: {
    configured: number;
    violations: ArchitectureBoundaryViolation[];
  };
  limits: string[];
}

const MODULE_ROOTS = new Set(["src", "lib", "app", "apps", "packages", "services", "modules"]);
const DATA_PATH_RE = /(?:^|[/_.-])(?:db|database|model|models|repository|repositories|schema|migration|migrations|prisma|orm|drizzle|sequelize)(?:[/_.-]|$)/i;
/** Prisma scalar types are not relations — a field typed `String` points at no model. */
const PRISMA_SCALARS = new Set(["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes", "Unsupported"]);

function relative(repo: string, file: string): string {
  return (path.isAbsolute(file) ? path.relative(repo, file) : file).replace(/\\/g, "/");
}

/** Keep the architecture view groups small enough to read. */
export function moduleOf(relativeFile: string): string {
  const parts = relativeFile.split("/").filter(Boolean);
  if (parts.length === 0) return "(root)";
  if (parts.length === 1) return "(root)";
  if (MODULE_ROOTS.has(parts[0])) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function sourceFiles(repo: string): string[] {
  const extensions = [...new Set(LANGUAGE_ADAPTERS.flatMap((adapter) => adapter.extensions))];
  return walkFiles(repo, extensions);
}

function moduleRole(u: RepoUnderstanding, modulePath: string): string {
  const top = modulePath.split("/")[0];
  return u.moduleMap.find((item) => item.dir === top)?.role ?? "source";
}

function aggregateModules(repo: string, files: string[]): ArchitectureModule[] {
  const byModule = new Map<string, ArchitectureModule>();
  for (const file of files) {
    const modulePath = moduleOf(relative(repo, file));
    const current = byModule.get(modulePath);
    if (current) current.files++;
    else byModule.set(modulePath, { path: modulePath, role: "source", files: 1, inbound: 0, outbound: 0 });
  }
  return [...byModule.values()].sort((a, b) => b.files - a.files || a.path.localeCompare(b.path));
}

function declaredDependencies(repo: string): { manifest: string; names: string[] }[] {
  const out: { manifest: string; names: string[] }[] = [];
  const pkgPath = path.join(repo, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8").replace(/^\uFEFF/, ""));
      const names = Object.keys({
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
        ...(pkg.optionalDependencies ?? {}),
        ...(pkg.peerDependencies ?? {}),
      });
      if (names.length) out.push({ manifest: "package.json", names });
    } catch { /* malformed manifest is reported by the dependency analyzers, not invented here */ }
  }

  const requirementFiles = ["requirements.txt", "requirements-dev.txt", "requirements/base.txt"];
  for (const manifest of requirementFiles) {
    const file = path.join(repo, manifest);
    if (!fs.existsSync(file)) continue;
    try {
      const names = fs.readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && !line.startsWith("-"))
        .map((line) => line.match(/^([A-Za-z0-9_.-]+)/)?.[1])
        .filter((name): name is string => Boolean(name));
      if (names.length) out.push({ manifest, names });
    } catch { /* unreadable manifest: no evidence */ }
  }

  const goMod = path.join(repo, "go.mod");
  if (fs.existsSync(goMod)) {
    try {
      const names = [...fs.readFileSync(goMod, "utf8").matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v/gim)]
        .map((match) => match[1]);
      if (names.length) out.push({ manifest: "go.mod", names });
    } catch { /* ignore */ }
  }

  const cargo = path.join(repo, "Cargo.toml");
  if (fs.existsSync(cargo)) {
    try {
      const section = fs.readFileSync(cargo, "utf8");
      const names = [...section.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:\{[^}]*version|[{"'])/gm)].map((match) => match[1]);
      if (names.length) out.push({ manifest: "Cargo.toml", names });
    } catch { /* ignore */ }
  }

  return out;
}

const SERVICES: { id: string; displayName: string; match: RegExp }[] = [
  { id: "stripe", displayName: "Stripe", match: /^stripe$|^@stripe\//i },
  { id: "twilio", displayName: "Twilio", match: /^twilio$/i },
  { id: "sendgrid", displayName: "SendGrid", match: /^@sendgrid\/|^sendgrid$/i },
  { id: "mailgun", displayName: "Mailgun", match: /^mailgun|^mailgun-js$/i },
  { id: "aws", displayName: "AWS", match: /^aws-sdk$|^@aws-sdk\//i },
  { id: "gcp", displayName: "Google Cloud", match: /^@google-cloud\//i },
  { id: "firebase", displayName: "Firebase", match: /^firebase$|^firebase-admin$/i },
  { id: "openai", displayName: "OpenAI", match: /^openai$/i },
  { id: "anthropic", displayName: "Anthropic", match: /^@anthropic-ai\//i },
  { id: "postgres", displayName: "PostgreSQL", match: /^pg$|^postgres$|^psycopg/i },
  { id: "mysql", displayName: "MySQL", match: /^mysql2?$|^mysqlclient$/i },
  { id: "mongodb", displayName: "MongoDB", match: /^mongodb$|^mongoose$/i },
  { id: "redis", displayName: "Redis", match: /^(?:redis|ioredis)$/i },
  { id: "kafka", displayName: "Kafka", match: /^kafkajs$|^kafka-python$/i },
  { id: "rabbitmq", displayName: "RabbitMQ", match: /^amqplib$|^pika$/i },
  { id: "elasticsearch", displayName: "Elasticsearch", match: /^@elastic\/|^elasticsearch$/i },
  { id: "s3", displayName: "S3-compatible storage", match: /^minio$|^@aws-sdk\/client-s3$/i },
];

function externalServices(repo: string): ExternalService[] {
  const found = new Map<string, ExternalService>();
  for (const manifest of declaredDependencies(repo)) {
    for (const name of manifest.names) {
      const service = SERVICES.find((candidate) => candidate.match.test(name));
      if (!service) continue;
      const current = found.get(service.id) ?? {
        id: service.id,
        displayName: service.displayName,
        evidence: [],
        files: [],
      };
      if (!current.evidence.includes(name)) current.evidence.push(name);
      if (!current.files.includes(manifest.manifest)) current.files.push(manifest.manifest);
      found.set(service.id, current);
    }
  }
  return [...found.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function scanPrismaRelationships(repo: string, out: ArchitectureRelationship[]): void {
  const file = path.join(repo, "prisma", "schema.prisma");
  if (!fs.existsSync(file)) return;
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return;
  }
  let model = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const modelMatch = /^\s*model\s+([A-Za-z_][\w]*)\s*\{/.exec(line);
    if (modelMatch) {
      model = modelMatch[1];
      continue;
    }
    if (!model) continue;
    if (/^\s*}/.test(line)) {
      model = "";
      continue;
    }
    const relation = /^\s*([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*)(?:\[\])?(?:\s+@relation.*)?$/.exec(line);
    if (!relation) continue;
    const [, field, target] = relation;
    if (!relation[0].includes("@relation") && !/(?:^|_)(?:id|Id)$/.test(field)) continue;
    if (!/^[A-Z]/.test(target) || target === model || PRISMA_SCALARS.has(target)) continue;
    out.push({
      from: model,
      to: target,
      kind: "relation",
      file: "prisma/schema.prisma",
      line: index + 1,
      confidence: "indicated",
    });
  }
}

function scanSqlRelationships(repo: string, out: ArchitectureRelationship[]): void {
  const files = walkFiles(repo, [".sql"]).slice(0, 50);
  for (const absolute of files) {
    let lines: string[];
    try {
      lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
    } catch {
      continue;
    }
    let table = "";
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const created = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][\w.]*)["'`]?/i.exec(line);
      if (created) table = created[1].split(".").pop() ?? created[1];
      const references = /^\s*(?:ALTER\s+TABLE\s+)?.*?\bREFERENCES\s+["'`]?([A-Za-z_][\w.]*)["'`]?/i.exec(line);
      if (!references || !table) continue;
      const target = references[1].split(".").pop() ?? references[1];
      out.push({
        from: table,
        to: target,
        kind: "foreign-key",
        file: relative(repo, absolute),
        line: index + 1,
        confidence: "indicated",
      });
    }
  }
}

function scanOrmRelationships(repo: string, out: ArchitectureRelationship[]): void {
  const files = walkFiles(repo, [".js", ".ts", ".jsx", ".tsx", ".py"]).slice(0, 200);
  const re = /(?:belongsTo|hasMany|hasOne|references)\s*\(\s*(?:\w+\s*,\s*)?["']([A-Za-z_][\w]*)["']/g;
  for (const absolute of files) {
    if (!DATA_PATH_RE.test(relative(repo, absolute))) continue;
    let content: string;
    try {
      content = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    const source = path.basename(absolute).replace(/\.[^.]+$/, "");
    let match: RegExpExecArray | null;
    while ((match = re.exec(content))) {
      const target = match[1];
      if (target === source) continue;
      out.push({
        from: source,
        to: target,
        kind: "relation",
        file: relative(repo, absolute),
        line: content.slice(0, match.index).split("\n").length,
        confidence: "indicated",
      });
    }
  }
}

function dataRelationships(repo: string): ArchitectureRelationship[] {
  const out: ArchitectureRelationship[] = [];
  scanPrismaRelationships(repo, out);
  scanSqlRelationships(repo, out);
  scanOrmRelationships(repo, out);
  const seen = new Set<string>();
  return out.filter((item) => {
    const key = `${item.kind}|${item.from}|${item.to}|${item.file}|${item.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dataFlows(repo: string, routes: AttackRoute[], edges: Map<string, Set<string>>): ArchitectureFlow[] {
  const out: ArchitectureFlow[] = [];
  // `edges` is normalized to repo-relative paths so both the regex and the
  // madge graph engines key the same way.
  const routeFiles = new Set(routes.map((route) => relative(repo, route.file)));
  for (const routeFile of routeFiles) {
    for (const target of edges.get(routeFile) ?? []) {
      const relativeTarget = relative(repo, target);
      if (!DATA_PATH_RE.test(relativeTarget)) continue;
      const route = routes.find((candidate) => relative(repo, candidate.file) === routeFile);
      if (!route) continue;
      out.push({
        from: `${route.method} ${route.path}`,
        to: relativeTarget,
        via: routeFile,
        confidence: "indicated",
      });
    }
  }
  return out;
}

function boundaryViolations(u: RepoUnderstanding, edges: Map<string, Set<string>>): ArchitectureBoundaryViolation[] {
  const out: ArchitectureBoundaryViolation[] = [];
  const rules = u.architecture.boundaries ?? [];
  if (rules.length === 0) return out;
  for (const [from, targets] of edges) {
    const fromRel = from.replace(/\\/g, "/");
    for (const target of targets) {
      const targetRel = target.replace(/\\/g, "/");
      for (const rule of rules) {
        if (!globMatches(rule.from, fromRel)) continue;
        const forbidden = rule.forbidImportsFrom.find((pattern) => globMatches(pattern, targetRel));
        if (!forbidden) continue;
        out.push({
          from: fromRel,
          to: targetRel,
          rule: Array.isArray(rule.from) ? rule.from.join(", ") : rule.from,
          target: forbidden,
          reason: rule.reason,
        });
      }
    }
  }
  return out;
}

/** Build the architecture view from real files, imports, routes and manifests. */
export async function buildArchitectureMap(repoInput: string): Promise<ArchitectureMap> {
  const repo = path.resolve(repoInput);
  const u = buildUnderstanding(repo);
  const analysis = await analyzeLanguages(repo);
  const surface = buildAttackSurface(analysis);
  const files = sourceFiles(repo);
  const modules = aggregateModules(repo, files);
  const built = buildEdges(repo);

  // Normalize once: the regex engine keys absolute paths and madge keys paths
  // relative to the repo, so every consumer below works in repo-relative form.
  const edges = new Map<string, Set<string>>();
  for (const [from, targets] of built?.edges ?? []) {
    const fromFile = relative(repo, from);
    if (!edges.has(fromFile)) edges.set(fromFile, new Set());
    for (const target of targets) edges.get(fromFile)!.add(relative(repo, target));
  }

  const dependencies: ArchitectureDependency[] = [];
  const edgeCounts = new Map<string, { from: string; to: string; imports: number }>();
  for (const [from, targets] of edges) {
    const fromModule = moduleOf(from);
    for (const target of targets) {
      const toModule = moduleOf(target);
      if (fromModule === toModule) continue;
      const key = `${fromModule}|${toModule}`;
      const current = edgeCounts.get(key);
      if (current) current.imports++;
      else edgeCounts.set(key, { from: fromModule, to: toModule, imports: 1 });
    }
  }
  for (const item of edgeCounts.values()) {
    dependencies.push(item);
    const source = modules.find((module) => module.path === item.from);
    const target = modules.find((module) => module.path === item.to);
    if (source) source.outbound += item.imports;
    if (target) target.inbound += item.imports;
  }
  dependencies.sort((a, b) => b.imports - a.imports || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  for (const module of modules) module.role = moduleRole(u, module.path);

  const cycles = built
    ? findCycles(edges).map((cycle) => cycle.map((file) => relative(repo, file)))
    : [];
  const relationships = dataRelationships(repo);
  const boundaries = boundaryViolations(u, edges);

  return {
    repo,
    generatedAt: new Date().toISOString(),
    engine: built?.engine ?? null,
    modules,
    dependencies,
    cycles,
    routes: surface.routes,
    entryPoints: [...new Set([...u.entryPoints, ...surface.entryPoints])].sort(),
    externalServices: externalServices(repo),
    dataRelationships: relationships,
    dataFlows: dataFlows(repo, surface.routes, edges),
    boundaries: {
      configured: u.architecture.boundaries?.length ?? 0,
      violations: boundaries,
    },
    limits: [
      built
        ? `Import graph engine: ${built.engine}. Only resolved relative imports are edges.`
        : "Import graph is unavailable for this repository (only JS/TS and Python file graphs are supported).",
      "Module dependencies are aggregated file imports; they are not runtime call graphs.",
      "Data relationships come from schema/ORM declarations and SQL REFERENCES clauses, not live queries.",
      "External services come from declared dependency manifests, not observed network traffic.",
      "Boundaries are the rules this repository declared; no rules means no boundary conclusion.",
      "Routes are parsed/lead-level candidates; route-to-data flows are import-path evidence, not runtime proof.",
    ],
  };
}
