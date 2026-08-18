/**
 * Lightweight natural-language router. Maps a free-text request (e.g.
 * "make this safe", "why is my score low") to the right `pitstop` command so
 * users never have to memorize command names. The slash-command templates and
 * `pitstop ask` both use this.
 */

export interface IntentMatch {
  command: string;
  label: string;
  example: string;
}

interface Rule {
  label: string;
  example: string;
  command: string;
  re: RegExp;
}

const RULES: Rule[] = [
  {
    label: "Autopilot fix",
    example: "pitstop fix",
    command: "pitstop fix",
    re: /\b(make (this|it|the repo) safe|secure (this|it|me|the app)|harden|fix (all|the|my) (vuln|issues?|bugs?|findings?)|lock (it )?down|clean (this|it) up)\b/,
  },
  {
    label: "Scan & explain the score",
    example: "pitstop scan",
    command: "pitstop scan",
    re: /\b(why (is|isn't|is my) (my )?(score|grade) (low|bad|red|so low)|what'?s (wrong|broken|off|the matter)|explain (my )?(score|report)|what (should|do) i (fix|do)|measure|audit|scan)\b/,
  },
  {
    label: "Pen-test & fix",
    example: "pitstop pen --fix",
    command: "pitstop pen --fix",
    re: /\b(pen( |-)?test|attack|exploit|red ?team|(try to )?break (it|this))\b/,
  },
  {
    label: "Verify the fix",
    example: "pitstop verify",
    command: "pitstop verify",
    re: /\b(verify|did (it|this|the fix) (actually )?(work|fix|stick)|prove (the )?fix|is it (really )?fixed|re-?run (the )?proof)\b/,
  },
  {
    label: "Gate / CI",
    example: "pitstop gate --score 60",
    command: "pitstop gate --score 60",
    re: /\b(gate|ci|pre-?commit|safe to commit|block bad|pipeline)\b/,
  },
  {
    label: "Report / share",
    example: "pitstop report",
    command: "pitstop report",
    re: /\b(report|share|score ?card|export|summary( for| me)?|show (me )?the report)\b/,
  },
  {
    label: "Honesty / evidence",
    example: "pitstop honesty",
    command: "pitstop honesty",
    re: /\b(honest|evidence|trust|prove (the )?numbers|trace)\b/,
  },
  {
    label: "What's next / pending",
    example: "pitstop next",
    command: "pitstop next",
    re: /\b(next|pending|where am i|what('s| is) left|todo|stuck)\b/,
  },
  {
    label: "Install",
    example: "pitstop install -y",
    command: "pitstop install -y",
    re: /\b(install|setup|set ?up|configure|add (the )?command)\b/,
  },
];

/** Resolve free text to a pitstop command. Returns null when nothing matches. */
export function matchIntent(text: string): IntentMatch | null {
  const t = ` ${text.toLowerCase()} `;

  // Dynamic: "fix <finding-id>" / "drive <id>" / "inspect <id>".
  const idMatch = t.match(/(?:fix|drive|inspect|show|detail)\b[^\n]{0,40}\b([a-z0-9]+-[0-9a-f]{6,})/);
  if (idMatch) {
    const verb = /\b(inspect|show|detail)\b/.test(t) ? "inspect" : "drive";
    return {
      command: `pitstop ${verb} ${idMatch[1]}`,
      label: verb === "inspect" ? "Inspect a finding" : "Fix a specific finding",
      example: `pitstop ${verb} ${idMatch[1]}`,
    };
  }

  for (const r of RULES) {
    if (r.re.test(t)) return { command: r.command, label: r.label, example: r.example };
  }
  return null;
}

export const INTENT_EXAMPLES = RULES.map((r) => ({ phrase: r.example, label: r.label }));
