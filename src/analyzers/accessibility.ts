import fs from "node:fs";
import path from "node:path";
import { commandExists, safeExec, walkFiles, lineOf } from "./util.js";
import type { ScanIssue, AccessibilityResult } from "./types.js";

const HTML_EXTS = [".html", ".htm"];
const JSX_EXTS = [".jsx", ".tsx"];
/** Cap the runtime sweep so a big static site doesn't hang the scan. */
const MAX_RUNTIME_FILES = 10;

/**
 * Accessibility analysis.
 *
 * HONEST CAVEATS (read before trusting these numbers):
 *
 * - Real runtime a11y testing (pa11y / axe-core) needs a LIVE page — a URL or a
 *   served build. A plain `pitstop scan` must not boot a long-lived dev server,
 *   so we only run runtime tools against static HTML files that already exist in
 *   the repo. If the app needs a build+serve step (Vite, webpack, etc.), runtime
 *   testing here is NOT attempted, and we say so in the note.
 * - The static JSX lint below is the reliable fallback. It is a light structural
 *   pass over JSX source (not a real DOM), so it can only catch obvious gaps:
 *   missing alt text, interactive elements without an accessible label, and
 *   non-semantic clickable `<div>`/`<span>`. It is NOT a substitute for running
 *   axe against the rendered page. Treat it as a triage signal, not a verdict.
 */
export function analyzeAccessibility(repo: string): AccessibilityResult {
  const htmlFiles = walkFiles(repo, HTML_EXTS);
  const jsxFiles = walkFiles(repo, JSX_EXTS);

  const skipped = (note: string): AccessibilityResult => ({
    status: "skipped",
    note,
    issues: [],
  });

  if (htmlFiles.length === 0 && jsxFiles.length === 0) {
    return skipped("no HTML or JSX found in repo");
  }

  // ---- Runtime path: static HTML only, needs the tool installed ----
  if (htmlFiles.length > 0) {
    if (commandExists("pa11y")) {
      const res = runStaticHtml(repo, htmlFiles, "pa11y");
      if (res) return res;
    }
    if (commandExists("axe")) {
      const res = runStaticHtml(repo, htmlFiles, "axe");
      if (res) return res;
    }
  }

  // ---- Static JSX lint fallback ----
  if (jsxFiles.length > 0) {
    const issues: ScanIssue[] = [];
    for (const f of jsxFiles) {
      let content: string;
      try {
        content = fs.readFileSync(f, "utf8");
      } catch {
        continue;
      }
      issues.push(...lintJsx(content, f, repo));
    }
    return {
      status: "ok",
      engine: "static-jsx",
      checked: { type: "jsx", count: jsxFiles.length },
      note:
        htmlFiles.length > 0
          ? "no pa11y/axe runtime tool installed for the static HTML; static JSX lint used instead"
          : "static JSX lint used (no live page to test at scan time)",
      issues,
    };
  }

  return skipped(
    "no pa11y/axe installed for the static HTML files, and no JSX to lint statically",
  );
}

/* ------------------------------------------------------------------ */
/* Runtime (static HTML)                                               */
/* ------------------------------------------------------------------ */

type Tool = "pa11y" | "axe";

/** Run the tool over up to MAX_RUNTIME_FILES static HTML files. */
function runStaticHtml(
  repo: string,
  htmlFiles: string[],
  tool: Tool,
): AccessibilityResult | null {
  const issues: ScanIssue[] = [];
  for (const f of htmlFiles.slice(0, MAX_RUNTIME_FILES)) {
    const r =
      tool === "pa11y"
        ? safeExec("pa11y", ["--json", f], repo, 120000)
        : safeExec("axe", [f, "--json"], repo, 120000);
    if (r.code !== 0 || !r.stdout) continue;
    try {
      const parsed = JSON.parse(r.stdout);
      issues.push(...(tool === "pa11y" ? parsePa11y(parsed, f) : parseAxe(parsed, f)));
    } catch {
      /* unparseable run — skip this file */
    }
  }
  if (issues.length === 0) return null;
  return {
    status: "ok",
    engine: tool,
    checked: { type: "html", count: htmlFiles.slice(0, MAX_RUNTIME_FILES).length },
    issues,
  };
}

function parsePa11y(arr: any[], file: string): ScanIssue[] {
  const out: ScanIssue[] = [];
  for (const item of arr) {
    const severity =
      item.type === "error" ? "high" : item.type === "warning" ? "medium" : "low";
    out.push({
      type: "a11y",
      severity,
      file,
      description: `${item.code}: ${item.message}${item.selector ? ` (${item.selector})` : ""}`,
    });
  }
  return out;
}

function parseAxe(json: any, file: string): ScanIssue[] {
  const out: ScanIssue[] = [];
  for (const v of json?.violations ?? []) {
    const impact = v.impact ?? "moderate";
    const severity =
      impact === "serious" || impact === "critical"
        ? "high"
        : impact === "moderate"
          ? "medium"
          : "low";
    out.push({
      type: "a11y",
      severity,
      file,
      description: `${v.id}: ${v.help ?? v.description ?? ""}`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Static JSX structural pass (the reliable fallback)                  */
/* ------------------------------------------------------------------ */

interface JsxElement {
  tag: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  innerText: string;
  line: number;
}

/**
 * Minimal JSX structure pass. This is deliberately a light stack-based parser
 * (tag name + attributes + matching close tag + text content), not a full AST.
 * It is tolerant of most real JSX and ignores JSX comments. It is not a DOM.
 */
function parseJsx(content: string): JsxElement[] {
  // Strip JSX comments ({/* ... */}) so their contents can't fake elements.
  const cleaned = content.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const elements: JsxElement[] = [];
  const stack: (JsxElement & { start: number })[] = [];

  const OPEN = /<([A-Za-z][\w.-]*)((?:\s+[\s\S]*?)?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = OPEN.exec(cleaned)) !== null) {
    const full = m[0];
    const tag = m[1];
    const attrText = m[2] ?? "";
    const selfClosing = m[3] === "/" || /\/>$/.test(full.trim());
    const line = lineOf(cleaned, m.index);
    const attrs = parseAttrs(attrText);

    if (selfClosing) {
      elements.push({ tag, attrs, selfClosing: true, innerText: "", line });
      continue;
    }
    // Paired tag — match its closing tag via the stack.
    const info: JsxElement & { start: number } = {
      tag,
      attrs,
      selfClosing: false,
      innerText: "",
      line,
      start: OPEN.lastIndex,
    };
    stack.push(info);
  }

  // Find closing tags to pop the stack and capture inner text.
  const CLOSE = /<\/([A-Za-z][\w.-]*)\s*>/g;
  let c: RegExpExecArray | null;
  while ((c = CLOSE.exec(cleaned)) !== null) {
    const closeTag = c[1];
    // Pop the most recent unclosed element with a matching tag.
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].tag === closeTag) {
        const open = stack.splice(i, 1)[0];
        open.innerText = textBetween(cleaned, open.start, c.index);
        elements.push(open);
        break;
      }
    }
  }

  return elements;
}

/** Text content with tags and whitespace collapsed (for visible-name checks). */
function textBetween(content: string, from: number, to: number): string {
  const slice = content.slice(from, to);
  return slice.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Parse a tag's attribute text into a name -> value map (values may be quoted). */
function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const ATTR = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(text)) !== null) {
    const name = m[1];
    const value = m[2] ?? m[3] ?? m[4] ?? m[5] ?? "";
    attrs[name] = value;
    // Also record the raw attr presence stripped of its value.
    attrs[`${name}::present`] = "";
  }
  return attrs;
}

const hasAttr = (attrs: Record<string, string>, name: string): boolean =>
  `${name}::present` in attrs;

const INTERACTIVE = new Set(["a", "button", "input", "select", "textarea", "summary"]);

function lintJsx(content: string, file: string, _repo: string): ScanIssue[] {
  const issues: ScanIssue[] = [];

  for (const el of parseJsx(content)) {
    const tag = el.tag.toLowerCase();

    // 1) <img> without alt text.
    if (tag === "img" && !hasAttr(el.attrs, "alt")) {
      issues.push({
        type: "a11y",
        severity: "warning",
        file,
        line: el.line,
        description: "<img> is missing an alt attribute (empty alt=\"\" is fine for decorative images)",
      });
    }

    // 2) Interactive controls missing an accessible label.
    if (INTERACTIVE.has(tag)) {
      const labelled =
        hasAttr(el.attrs, "aria-label") || hasAttr(el.attrs, "aria-labelledby") || hasAttr(el.attrs, "title");
      const hasText = tag === "input" || tag === "select" || tag === "textarea"
        ? false // these elements carry no visible text of their own
        : el.innerText.length > 0;
      if (!labelled && !hasText) {
        issues.push({
          type: "a11y",
          severity: "warning",
          file,
          line: el.line,
          description: `<${tag}> has no accessible label (add aria-label, aria-labelledby, title, or ${tag === "a" || tag === "button" ? "visible text" : "a placeholder/id"})`,
        });
      }
    }

    // 3) Non-semantic clickable <div>/<span>.
    if ((tag === "div" || tag === "span") && hasAttr(el.attrs, "onClick")) {
      const hasRole = hasAttr(el.attrs, "role");
      const hasKeyboard = hasAttr(el.attrs, "onKeyDown") && hasAttr(el.attrs, "tabIndex");
      issues.push({
        type: "a11y",
        severity: hasRole && hasKeyboard ? "info" : "warning",
        file,
        line: el.line,
        description:
          hasRole && hasKeyboard
            ? `clickable <${tag}> is keyboard-accessible (role+tabIndex+onKeyDown) — confirm a <button>/<a> is not a better fit`
            : `clickable <${tag}> is not keyboard-accessible — prefer a semantic <button>/<a> or add role="button", tabIndex, and onKeyDown`,
      });
    }
  }
  return issues;
}