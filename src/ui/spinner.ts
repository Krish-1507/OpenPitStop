import ora from "ora";
import chalk from "chalk";

/**
 * Spinner wrapper with two modes:
 *
 * - TTY               → ora spinner rendered on STDOUT. Overriding the default
 *                       stderr stream avoids PowerShell 5.1 painting every
 *                       spinner frame as a red "RemoteException" error record,
 *                       which made the very first `pitstop scan` look broken.
 * - non-TTY (CI/pipe) → ora is a no-op there; instead we print a plain "text…"
 *                       line at start and a plain ✓/✗ line at the end, so CI
 *                       logs still read as a coherent step instead of a terse
 *                       spinner glyph that never clears.
 */

export interface Spinner {
  succeed(text?: string): void;
  warn(text?: string): void;
  fail(text?: string): void;
}

export function createSpinner(text: string): Spinner {
  if (!process.stderr.isTTY) {
    console.log(chalk.dim(`${text}…`));
    return {
      succeed: (t?: string) => {
        if (t) console.log(chalk.green(`✓ ${t}`));
      },
      warn: (t?: string) => {
        console.log(chalk.yellow(`⚠ ${t ?? text}`));
      },
      fail: (t?: string) => {
        console.log(chalk.red(`✗ ${t ?? text}`));
      },
    };
  }
  const spin = ora({ text, stream: process.stdout }).start();
  return {
    succeed: (t?: string) => spin.succeed(t),
    warn: (t?: string) => spin.warn(t),
    fail: (t?: string) => spin.fail(t),
  };
}