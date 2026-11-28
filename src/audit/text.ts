/**
 * audit/text.ts — small, security-aware text helpers.
 */

/** 1-based line excerpt, trimmed and capped. */
export function lineExcerpt(content: string, line: number, max = 160): string {
  const raw = content.split(/\r?\n/)[Math.max(0, line - 1)] ?? "";
  return redact(raw.trim()).slice(0, max);
}

/** Mask credential-shaped text; evidence must never leak a secret. */
export function redact(text: string): string {
  let out = text;
  // Authorization values include a scheme and token separated by whitespace;
  // mask the complete value before the generic label rule can stop at "Bearer".
  out = out.replace(
    // Mask the complete header value, not just the first whitespace-delimited
    // token: "Authorization: Bearer <token> extra" must not leak the tail.
    /(\bauthorization\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;]+)/gi,
    "$1[redacted]",
  );
  // Match a complete quoted value, or one unquoted token, so a quoted secret
  // cannot leak its tail after the first word. The prefix is not a word
  // boundary: an env-style name such as AWS_SECRET_ACCESS_KEY is still a label.
  out = out.replace(
    /(^|[^A-Za-z0-9])((?:api[_-]?key|secret(?:[_-](?:access[_-]?)?key)?|token|password|passwd|private[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s,;'"]+)/gi,
    "$1$2[redacted]",
  );
  out = out.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, "[redacted-aws-key]");
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted-token]");
  out = out.replace(/\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g, "[redacted-key]");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted-key]");
  out = out.replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[redacted-google-key]");
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted-slack-token]");
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-jwt]");
  out = out.replace(
    /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/)[^:\s/@]+:[^@\s/]+@/gi,
    "$1[redacted]@",
  );
  out = out.replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*/g, "[redacted-private-key]");
  return out;
}

export function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function relativePath(repo: string, file: string): string {
  const normalized = file.replace(/\\/g, "/");
  const root = repo.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.startsWith(root + "/") ? normalized.slice(root.length + 1) : normalized;
}

/** A stable short hash, used for finding ids. */
export function shortHash(input: string, length = 10): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = (h2 >>> 0) * 0x100000000 + (h1 >>> 0);
  return value.toString(16).padStart(16, "0").slice(0, length);
}
