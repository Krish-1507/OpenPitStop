import type { LanguageAnalysis } from "./types.js";

export interface AttackRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  privileged: boolean;
}

export interface AttackSurfaceMap {
  repo: string;
  primaryLanguage: string;
  routes: AttackRoute[];
  entryPoints: string[];
  authenticationFiles: string[];
  dataAccessFiles: string[];
  infrastructure: { displayName: string; files: string[] }[];
  limits: string[];
}

const AUTH_RE = /(?:^|[/_.-])(?:auth|authn|authz|middleware|guard|permission|policy|acl|session|oauth|jwt)(?:[/_.-]|$)/i;
const DATA_RE = /(?:^|[/_.-])(?:db|database|model|models|repository|repositories|schema|migration|prisma|orm|drizzle|sequelize)(?:[/_.-]|$)/i;
const PRIVILEGED_RE = /(?:^|[/_.-])(?:admin|internal|manage|management|private|superuser|root)(?:[/_.-]|$)/i;

/**
 * Build a conservative attack-surface map from parsed sources. Labels are
 * filename/route evidence, not proof of authorization boundaries.
 */
export function buildAttackSurface(analysis: LanguageAnalysis): AttackSurfaceMap {
  const routes: AttackRoute[] = [];
  const seen = new Set<string>();
  const auth = new Set<string>();
  const data = new Set<string>();
  for (const file of analysis.files) {
    if (AUTH_RE.test(file.file)) auth.add(file.file);
    if (DATA_RE.test(file.file)) data.add(file.file);
    for (const route of file.routes) {
      const key = `${route.method}:${route.path}:${file.file}:${route.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({
        ...route,
        file: file.file,
        privileged: PRIVILEGED_RE.test(route.path) || PRIVILEGED_RE.test(file.file),
      });
    }
  }
  const entryPoints = [...new Set(analysis.support.flatMap((support) => support.entryPoints))];
  return {
    repo: analysis.repo,
    primaryLanguage: analysis.primaryLanguage,
    routes: routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
    entryPoints,
    authenticationFiles: [...auth].sort(),
    dataAccessFiles: [...data].sort(),
    infrastructure: analysis.infrastructure.map((item) => ({ displayName: item.displayName, files: item.files })),
    limits: [
      "Routes are discovered from source patterns and parsed syntax; they are leads, not live endpoint proof.",
      "Auth/data labels come from file paths, not from control-flow or permission analysis.",
      analysis.limits.skippedFiles > 0
        ? `${analysis.limits.skippedFiles} source file(s) exceeded the per-language parse limit and may contain routes not shown.`
        : "All detected source files within the per-language parse limit were inspected.",
    ],
  };
}
