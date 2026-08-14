#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import { install } from "./commands/install.js";
import { scan } from "./commands/scan.js";
import { verify } from "./commands/verify.js";
import { memory } from "./commands/memory.js";
import { report } from "./commands/report.js";
import { demo } from "./commands/demo.js";
import { ci } from "./commands/ci.js";
import { reproCmd } from "./commands/repro.js";
import { integrity } from "./commands/integrity.js";
import { inspect } from "./commands/inspect.js";
import { trends } from "./commands/trends.js";
import { doctor } from "./commands/doctor.js";
import { prompt } from "./commands/prompt.js";
import { try_ } from "./commands/try.js";
import { gate } from "./commands/gate.js";
import { share } from "./commands/share.js";
import { digest } from "./commands/digest.js";
import { honesty } from "./commands/honesty.js";
import { pen } from "./commands/pen.js";
import { readyCheckCmd } from "./commands/readyCheck.js";
import { budgetCmd } from "./commands/budget.js";
import { watch } from "./commands/watch.js";
import { drive } from "./commands/drive.js";

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("pitstop")
  .description("OpenPitStop CLI")
  .version(readVersion());

program.addCommand(install);
program.addCommand(scan);
program.addCommand(verify);
program.addCommand(memory);
program.addCommand(report);
program.addCommand(demo);
program.addCommand(ci);
program.addCommand(reproCmd);
program.addCommand(integrity);
program.addCommand(inspect);
program.addCommand(trends);
program.addCommand(doctor);
program.addCommand(prompt);
program.addCommand(try_);
program.addCommand(gate);
program.addCommand(share);
program.addCommand(digest);
program.addCommand(honesty);
program.addCommand(pen);
program.addCommand(readyCheckCmd);
program.addCommand(budgetCmd);
program.addCommand(watch);
program.addCommand(drive);

program.parseAsync(process.argv);
