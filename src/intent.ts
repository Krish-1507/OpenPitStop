/** Offline intent routing. User text is data, never a shell command. */
export interface IntentMatch {
  command: string;
  args: string[];
  label: string;
  example: string;
  requiresExecution: boolean;
  effect: string;
}

interface Rule {
  label: string;
  phrase: string;
  args: string[];
  re: RegExp;
  effect?: string;
}

const RULES: Rule[] = [
  { label: "Next step", phrase: "what should I do next", args: ["next"], re: /\b(next|pending|where am i|what('s| is) left|todo|stuck)\b/ },
  { label: "Repository understanding", phrase: "understand this repo", args: ["understand"], re: /\b(understand|explain|map) (this |my |the )?(repo(sitory)?|codebase|architecture|project)\b/ },
  { label: "Architecture and boundaries", phrase: "check architecture boundaries", args: ["architecture-check"], re: /\b(architecture|boundaries|ownership|scope creep|existing patterns)\b/ },
  { label: "Integrity check", phrase: "did my agent cheat", args: ["integrity"], re: /\b(cheat|cheating|integrity|tamper|deleted tests?|weakened tests?)\b/ },
  { label: "Verification stack", phrase: "check tests types lint and build", args: ["verify-stack"], re: /\b(typecheck|type check|lint|build|verification stack)\b/ },
  { label: "Test pyramid", phrase: "run all test layers", args: ["test"], re: /\b(test pyramid|test layers|unit|integration|e2e|run (all |the |my )?tests?)\b/ },
  { label: "Full engineering verification", phrase: "review my changes", args: ["flow"], re: /\b(review (my |these |the )?changes|full (review|verification)|engineering review)\b/ },
  { label: "Evidence chain", phrase: "explain the evidence", args: ["explain"], re: /\b(evidence|trust|prove (the )?numbers|trace)\b/ },
  { label: "Cost and activity", phrase: "show my budget", args: ["budget"], re: /\b(budget|credits?|tokens?|cost|spend)\b/ },
  { label: "Progress over time", phrase: "show my progress", args: ["digest"], re: /\b(progress|history|what changed|improv(e|ed|ement))\b/ },
  { label: "Toolchain diagnosis", phrase: "why are checks skipped", args: ["doctor"], re: /\b(doctor|missing tools?|skipped|toolchain)\b/ },
  { label: "Autopilot fix", phrase: "make this safe", args: ["fix"], re: /\b(make (this|it|the repo) safe|secure (this|it|me|the app)|harden|fix (all|the|my) (vuln\w*|issues?|bugs?|findings?)|lock (it )?down|clean (this|it) up)\b/, effect: "Boots the local app, writes repro tests and applies supported patches. No model calls." },
  { label: "Live security testing", phrase: "attack my app", args: ["pen"], re: /\b(pen( |-)?test|attack|hack|exploit|red ?team|(try to )?break (it|this))\b/, effect: "Runs the app and attack traffic inside a disposable, network-isolated Docker container. Docker is required." },
  { label: "Static security review", phrase: "check the security of this app", args: ["pen", "--static"], re: /\b(security|vulnerabilit\w*|insecure)\b/ },
  { label: "Verify the change", phrase: "did the fix work", args: ["verify"], re: /\b(verify|verified|did (it|this|the fix) (actually )?(work|fix|stick)|prove (the )?fix|is it (really )?fixed|re-?run (the )?proof)\b/ },
  { label: "Release gate", phrase: "can I ship this", args: ["gate", "--strict"], re: /\b(gate|ci|pre-?commit|safe to commit|can i ship|ready to ship|block bad|pipeline)\b/ },
  { label: "Report", phrase: "show the report", args: ["report"], re: /\b(report|share|score ?card|export|summary)\b/ },
  { label: "Limits and honesty", phrase: "show your limits", args: ["honesty"], re: /\b(honest|honesty|limits|limitations)\b/ },
  { label: "Scan repository", phrase: "what is wrong with my repo", args: ["scan", "--reuse"], re: /\b(score|grade|what'?s (wrong|broken|off)|what is wrong|what (should|do) i (fix|do)|measure|audit|scan|flaky)\b/ },
  { label: "Install agent integration", phrase: "install the slash command", args: ["install"], re: /\b(install|setup|set ?up|configure|add (the )?command)\b/, effect: "Writes agent command files; the installer shows the destinations." },
];

function match(args: string[], label: string, effect?: string): IntentMatch {
  const command = `pitstop ${args.join(" ")}`;
  return { command, args, label, example: command, requiresExecution: !!effect,
    effect: effect ?? "Runs local checks and may write reports. Repository test/build scripts can execute code." };
}

export function matchIntent(text: string): IntentMatch | null {
  let t = text.toLowerCase().replace(/[’‘]/g, "'").trim().replace(/^\/pitstop\s+/, "");
  // Decline exclusions rather than silently ignoring a user's constraint.
  if (!t || /[;`\n\r]|\$\(|&&|\|\||\b(don't|dont|do not|never|without|except|but|only)\b/.test(t)) return null;
  if (/^(please )?find and fix (any |all |the )?vulnerabilit\w*( in (this|my|the) repo(sitory)?)?$/.test(t)) t = "make this safe";
  const id = t.match(/^(fix|drive|inspect|show|detail)\s+([a-z][a-z0-9-]*-[a-z0-9]{6,})$/);
  if (id) {
    const inspect = /^(inspect|show|detail)$/.test(id[1]);
    return match([inspect ? "inspect" : "drive", id[2]], inspect ? "Inspect a finding" : "Fix a finding with your agent",
      inspect ? undefined : "Starts your configured coding agent, which can edit files and consume its own credits.");
  }
  const hits = RULES.filter((r) => r.re.test(t));
  if (hits.some((r) => r.effect) && hits.some((r) => !r.effect) && /\b(and|then)\b/.test(t)) return null;
  const r = hits[0];
  return r ? match(r.args, r.label, r.effect) : null;
}

export const INTENT_EXAMPLES = RULES.map((r) => ({ phrase: r.phrase, label: r.label }));
