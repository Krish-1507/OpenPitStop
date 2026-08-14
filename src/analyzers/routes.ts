import { lineOf } from "./util.js";

/**
 * routes.ts — language-aware HTTP route discovery shared by `pitstop pen`
 * (dynamic route inventory) and ledger mode (endpoint discovery).
 *
 * Heuristic by design: a route match is a lead, never a proof. Frameworks
 * covered: Express/Fastify/plain http (JS), Flask/FastAPI/Django (Python),
 * gin/echo/chi/gorilla-mux/net-http (Go), axum/actix-web (Rust), Spring
 * (Java), ASP.NET (C#), shelf (Dart).
 */

export interface RouteMatch {
  method: string;
  path: string;
  line: number;
}

export const ROUTE_EXTS = [
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java", ".kt",
  ".cs",
  ".dart",
];

/** Express / Fastify / plain Node. */
const JS_ROUTE_RE =
  /(?:^|\s)(?:app|router|route|fastify|server|instance|application)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(['"`])([^'"`]+)\2/g;

/** Flask / FastAPI decorators + Django urlpatterns. */
const PY_ROUTE_RE =
  /@\s*[\w.]*\.\s*(route|get|post|put|patch|delete)\s*\(\s*(['"])([^'"]+)\2|\b(?:path|re_path)\s*\(\s*(['"])([^'"]+)\4\s*,\s*\s*views\.([\w]+)/g;

/**
 * Go: gin (r.GET), echo (e.GET), fiber (app.Get), chi/gorilla (r.Get,
 * r.HandleFunc), net/http (http.HandleFunc/Handle). Chi/gorilla/net-http
 * registrations are method-agnostic — probe as GET (least destructive).
 */
const GO_ROUTE_RE =
  /\.\s*(?:(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|Any)\s*\(\s*(['"`])([^'"`]+)\2|(HandleFunc|Handle)\s*\(\s*(['"`])([^'"`]+)\5)/g;

/** Rust: axum `.route("/x", get(handler))` and actix-web `#[get("/x")]` macros. */
const RS_ROUTE_RE =
  /\.\s*route\s*\(\s*(['"])([^'"]+)\1\s*,\s*(get|post|put|patch|delete)\s*\(|#\s*\[\s*(get|post|put|patch|delete)\s*\(\s*(['"])([^'"]+)\5\s*\)\s*\]/g;

/** Java Spring: @GetMapping / @PostMapping / @RequestMapping. */
const JAVA_ROUTE_RE =
  /@\s*(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*\(\s*(?:path\s*=\s*)?(["'])([^"']+)\2/g;

/** ASP.NET: [HttpGet("...")] / [HttpPost("...")] / [Route("...")]. */
const CS_ROUTE_RE =
  /#?\s*\[\s*(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|Route)\s*\(\s*(["'])([^"']+)\2/g;

/** Dart shelf: router.get('/path', ...) etc. */
const DART_ROUTE_RE =
  /\b(?:router|app|server|route)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"])([^'"]+)\2/g;

const METHOD_OF = (m: string): string => {
  const u = m.toUpperCase();
  if (u === "ANY" || u === "HANDLEFUNC" || u === "HANDLE" || u === "ROUTE") return "GET";
  return u;
};

/** Discover routes in one source file by its extension. */
export function findRoutesInFile(content: string, ext: string): RouteMatch[] {
  const routes: RouteMatch[] = [];
  let m: RegExpExecArray | null;
  switch (ext) {
    case ".js":
    case ".jsx":
    case ".ts":
    case ".tsx":
    case ".mjs":
    case ".cjs":
      JS_ROUTE_RE.lastIndex = 0;
      while ((m = JS_ROUTE_RE.exec(content)) !== null) {
        routes.push({ method: m[1].toUpperCase(), path: m[3], line: lineOf(content, m.index + m[0].length) });
      }
      break;
    case ".py":
      PY_ROUTE_RE.lastIndex = 0;
      while ((m = PY_ROUTE_RE.exec(content)) !== null) {
        if (m[3]) {
          routes.push({
            method: m[1] === "route" ? "POST" : m[1].toUpperCase(),
            path: m[3],
            line: lineOf(content, m.index + m[0].length),
          });
        } else if (m[5]) {
          routes.push({ method: "POST", path: m[5], line: lineOf(content, m.index + m[0].length) });
        }
      }
      break;
    case ".go":
      GO_ROUTE_RE.lastIndex = 0;
      while ((m = GO_ROUTE_RE.exec(content)) !== null) {
        const method = m[1] || m[4] || "";
        const p = m[3] || m[6] || "";
        if (p) routes.push({ method: METHOD_OF(method), path: p, line: lineOf(content, m.index + m[0].length) });
      }
      break;
    case ".rs":
      RS_ROUTE_RE.lastIndex = 0;
      while ((m = RS_ROUTE_RE.exec(content)) !== null) {
        const method = m[3] || m[4] || "GET";
        const p = m[2] || m[6] || "";
        if (p) routes.push({ method: METHOD_OF(method), path: p, line: lineOf(content, m.index + m[0].length) });
      }
      break;
    case ".java":
    case ".kt":
      JAVA_ROUTE_RE.lastIndex = 0;
      while ((m = JAVA_ROUTE_RE.exec(content)) !== null) {
        routes.push({
          method: m[1].toUpperCase().replace(/MAPPING$/, ""),
          path: m[3],
          line: lineOf(content, m.index + m[0].length),
        });
      }
      break;
    case ".cs":
      CS_ROUTE_RE.lastIndex = 0;
      while ((m = CS_ROUTE_RE.exec(content)) !== null) {
        const u = m[1].toUpperCase();
        routes.push({
          method: u === "ROUTE" ? "GET" : u.replace(/^HTTP/, ""),
          path: m[3],
          line: lineOf(content, m.index + m[0].length),
        });
      }
      break;
    case ".dart":
      DART_ROUTE_RE.lastIndex = 0;
      while ((m = DART_ROUTE_RE.exec(content)) !== null) {
        routes.push({ method: m[1].toUpperCase(), path: m[3], line: lineOf(content, m.index + m[0].length) });
      }
      break;
  }
  return routes;
}
