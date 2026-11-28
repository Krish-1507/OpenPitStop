import type { PythonFileIndex, PythonFunction } from "./indexTypes.js";

/**
 * audit/pythonIndex.ts — Python structure without claiming an AST.
 *
 * Symbols, ranges and imports come from an indentation scan; calls and
 * complexity are lexical. This is enough for precise empty-except and
 * long/complex-function findings, and it is explicitly NOT a call graph.
 * The full language layer remains the place where Python is parsed with
 * python3's AST when that interpreter is available.
 */

const KEYWORDS = new Set([
  "if", "elif", "else", "for", "while", "def", "class", "return", "yield", "with", "as",
  "try", "except", "finally", "raise", "import", "from", "pass", "break", "continue",
  "lambda", "and", "or", "not", "in", "is", "assert", "del", "global", "nonlocal",
]);

function stripComment(line: string): string {
  let quote: string | null = null;
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (ch === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#") break;
    out += ch;
  }
  return out;
}

function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].replace(/\t/g, "    ").length : 0;
}

function lineRangeEnd(lines: string[], startIndex: number, indent: number): number {
  let end = startIndex;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (indentOf(line) <= indent) break;
    end = i;
  }
  return end;
}

function callsIn(lines: string[], from: number, to: number): { name: string; line: number }[] {
  const calls: { name: string; line: number }[] = [];
  for (let i = from; i <= to && i < lines.length; i++) {
    const code = stripComment(lines[i]);
    if (!code.trim() || /^\s*(?:async\s+)?def\s+/.test(code)) continue;
    const re = /([A-Za-z_][\w.]*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(code)) !== null) {
      const name = match[1];
      const last = name.split(".").pop() ?? name;
      if (!KEYWORDS.has(last)) calls.push({ name, line: i + 1 });
    }
  }
  return calls;
}

export function parsePythonFile(relative: string, content: string): PythonFileIndex {
  const lines = content.split(/\r?\n/);
  const index: PythonFileIndex = {
    file: relative,
    lines: lines.length,
    functions: [],
    imports: [],
    broadExcept: [],
    strings: [],
    numbers: [],
    calls: [],
    tests: [],
    usedNames: [],
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = stripComment(raw);
    if (!code.trim()) continue;

    const importMatch = /^\s*import\s+(.+)$/.exec(code);
    if (importMatch) {
      for (const part of importMatch[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (name) index.imports.push({ specifier: name, line: i + 1 });
      }
    }
    const fromMatch = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/.exec(code);
    if (fromMatch) {
      index.imports.push({ specifier: fromMatch[1], line: i + 1 });
    }

    const defMatch = /^(\s*)(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(code);
    if (defMatch) {
      const indent = defMatch[1].replace(/\t/g, "    ").length;
      const end = lineRangeEnd(lines, i, indent);
      const bodyLines = lines.slice(i, end + 1);
      const bodyCode = bodyLines.map(stripComment).join("\n");
      let cyclomatic = 1;
      for (const keyword of bodyCode.match(/\b(if|elif|for|while|except|and|or)\b/g) ?? []) {
        if (keyword) cyclomatic += 1;
      }
      const calls = callsIn(lines, i, end);
      const loopCalls = loopCallsIn(lines, i, end);
      const fn: PythonFunction = {
        name: defMatch[3],
        line: i + 1,
        endLine: end + 1,
        loc: Math.max(1, end - i + 1),
        async: Boolean(defMatch[2]),
        cyclomatic,
        awaits: (bodyCode.match(/\bawait\b/g) ?? []).length,
        calls,
        inLoopCalls: loopCalls,
        hasAssert: /\bassert\b|pytest\.raises|self\.assert\w+/.test(bodyCode),
      };
      index.functions.push(fn);
      // Body calls are collected once by the line scan below; pushing `calls`
      // here as well double-counted every Python call site.
      if (fn.name.startsWith("test_")) {
        const prefix = lines.slice(Math.max(0, i - 3), i).join("\n");
        const skipped = /pytest\.mark\.skip|@unittest\.skip|pytest\.skip\(|self\.skipTest/.test(prefix + bodyCode);
        index.tests.push({ name: fn.name, line: fn.line, hasAssertion: fn.hasAssert, skipped });
      }
      continue;
    }

    const exceptMatch = /^(\s*)except\s*([\w.]*)\s*(?:as\s+\w+)?\s*:/.exec(code);
    if (exceptMatch) {
      const indent = exceptMatch[1].replace(/\t/g, "    ").length;
      const end = lineRangeEnd(lines, i, indent);
      const body = lines
        .slice(i + 1, end + 1)
        .map((line) => stripComment(line).trim())
        .filter(Boolean);
      const type = exceptMatch[2] ?? "";
      const broad = type === "" || type === "Exception" || type === "BaseException";
      if (broad && (body.length === 0 || body.every((line) => line === "pass" || line === "..."))) {
        index.broadExcept.push({ line: i + 1, endLine: end + 1, empty: true });
      }
    }

    const testMatch = /^(\s*)(?:async\s+)?def\s+(test_\w+)\s*\(/.exec(code);
    if (testMatch) {
      const indent = testMatch[1].replace(/\t/g, "    ").length;
      const end = lineRangeEnd(lines, i, indent);
      const body = lines.slice(i + 1, end + 1).join("\n");
      const skip = /pytest\.mark\.skip|@unittest\.skip|pytest\.skip\(|self\.skipTest/.test(lines.slice(Math.max(0, i - 3), i).join("\n") + body);
      index.tests.push({ name: testMatch[2], line: i + 1, hasAssertion: /\bassert\b|pytest\.raises|self\.assert\w+/.test(body), skipped: skip });
      continue;
    }

    const stringRe = /(['"])((?:\\.|(?!\1).)*)\1/g;
    let stringMatch: RegExpExecArray | null;
    while ((stringMatch = stringRe.exec(code)) !== null) {
      const value = stringMatch[2].replace(/\\n/g, "\n").replace(/\\'/g, "'").replace(/\\"/g, '"');
      if (value) index.strings.push({ value, line: i + 1, inFunction: false });
    }

    const numberRe = /\b\d{2,}(?:\.\d+)?\b/g;
    let numberMatch: RegExpExecArray | null;
    while ((numberMatch = numberRe.exec(code)) !== null) {
      index.numbers.push({ value: Number(numberMatch[0]), line: i + 1, inFunction: false });
    }

    const re = /([A-Za-z_][\w.]*)\s*\(/g;
    let callMatch: RegExpExecArray | null;
    while ((callMatch = re.exec(code)) !== null) {
      const last = callMatch[1].split(".").pop() ?? callMatch[1];
      if (!KEYWORDS.has(last)) index.calls.push({ name: callMatch[1], line: i + 1 });
    }

    for (const token of code.match(/[A-Za-z_]\w*/g) ?? []) {
      if (!KEYWORDS.has(token)) index.usedNames.push(token);
    }
  }

  index.usedNames = [...new Set(index.usedNames)].sort();
  for (const fn of index.functions) {
    const start = fn.line - 1;
    const end = fn.endLine - 1;
    for (const string of index.strings) {
      if (string.line > start && string.line <= end + 1) string.inFunction = true;
    }
    for (const number of index.numbers) {
      if (number.line > start && number.line <= end + 1) number.inFunction = true;
    }
  }
  return index;
}

/** Calls lexically inside a for/while body, including nested blocks. */
function loopCallsIn(lines: string[], from: number, to: number): { name: string; line: number }[] {
  const calls: { name: string; line: number }[] = [];
  let loopIndent = -1;
  for (let i = from; i <= to && i < lines.length; i++) {
    const code = stripComment(lines[i]);
    if (!code.trim()) continue;
    const indent = indentOf(code);
    const loop = /^\s*(?:async\s+)?(?:for|while)\b/.test(code);
    if (loop) {
      loopIndent = indent;
      continue;
    }
    if (loopIndent >= 0 && indent <= loopIndent) loopIndent = -1;
    if (loopIndent >= 0) {
      const re = /([A-Za-z_][\w.]*)\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(code)) !== null) {
        const last = match[1].split(".").pop() ?? match[1];
        if (!KEYWORDS.has(last)) calls.push({ name: match[1], line: i + 1 });
      }
    }
  }
  return calls;
}
