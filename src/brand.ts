import chalk from "chalk";

export const PRODUCT = "OpenPitStop";
export const TAGLINE = "the honest referee for AI coding agents";

/** Compact ANSI wordmark used at the top of terminal output. */
export function brandHeader(): string {
  return chalk.cyan.bold(PRODUCT) + chalk.dim(` — ${TAGLINE}`);
}

/** A slightly larger bordered banner for hero moments (autopilot, celebration). */
export function brandBanner(): string {
  const line = `${chalk.cyan.bold("◆")} ${chalk.bold(PRODUCT)} ${chalk.dim("·")} ${chalk.dim(TAGLINE)}`;
  return line;
}

/** Inline SVG mark — a rounded "P" chip with a blue→green gradient. */
export const LOGO_SVG = `<svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="OpenPitStop">
  <defs>
    <linearGradient id="opsGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#58a6ff"/>
      <stop offset="1" stop-color="#3fb950"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="36" height="36" rx="11" fill="url(#opsGrad)"/>
  <path d="M13 28V12h12a6 6 0 0 1 0 12h-7" fill="none" stroke="#0d1117" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="28" cy="12" r="2.6" fill="#0d1117"/>
</svg>`;

/** HTML brand bar (logo + wordmark + tagline) for the report header. */
export function brandBarHtml(): string {
  return `<div class="brand">
    ${LOGO_SVG}
    <div class="brand-text">
      <div class="brand-name">${PRODUCT}</div>
      <div class="brand-tag">${TAGLINE}</div>
    </div>
  </div>`;
}
