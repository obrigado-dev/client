#!/usr/bin/env bun
/**
 * `obrigado` — install | uninstall | statusline | status | projects | share | …
 *
 * §3 governs everything here: sponsored copy appears only in host-owned status
 * or lifecycle UI. Never in prompts, code, context, shell history, or generated
 * output. It is always labeled.
 *
 * This file is dispatch only; each command lives in `./commands`.
 */
import { config, refresh } from "./commands/config.ts";
import { install, uninstall } from "./commands/install.ts";
import { printRetrievalHook, projects, read, share, summary } from "./commands/projects.ts";
import { doctor, status } from "./commands/status.ts";
import { statusline } from "./commands/statusline.ts";

const USAGE = `obrigado — sponsored status lines that fund your dependencies

  obrigado install             configure every detected supported agent
  obrigado install --agent claude-code|opencode|codex
  obrigado install --chain     keep your existing statusline, add ours beneath
  obrigado install --replace   take over an existing statusline (reversible)
  obrigado uninstall [--agent claude-code|opencode|codex]
  obrigado status              this month, all time, and top funded packages
  obrigado projects            every package this install has funded, ranked
  obrigado share               a public page for what this install funds
  obrigado share create        issue a link; share revoke kills it
  obrigado config              show settings; config <name> <value> to change one
  obrigado refresh             discard the cached batch and fetch a new one
  obrigado statusline          render one line (called by the host)
  obrigado statusline --agent <host>  the same line, attributed to that host
  obrigado statusline --json   the line's parts, for a host that draws its own UI
  obrigado summary             one-line session summary (--json for a hook)
  obrigado summary --print-hook  the hook config to paste, if you want it
  obrigado read --print-hook   opt into retrieval weighting (packages you read count 2x)
  obrigado doctor              diagnostics

70% of gross revenue goes to the open-source packages your project depends on.
You earn nothing. https://obrigado.dev
`;

/**
 * Dispatch table.
 *
 * Each handler takes the remaining argv so subcommands (`share create`) and flags
 * (`summary --json`) do not need a parser. Adding one for two cases would be more
 * code than the cases.
 */
const commands: Record<string, (argv: readonly string[]) => Promise<number>> = {
  install: (argv) => install(argv),
  uninstall: (argv) => uninstall(argv),
  config: () => config(),
  refresh: () => refresh(),
  status: () => status(),
  projects: () => projects(),
  share: (argv) => share(argv[0]),
  summary: (argv) => summary(argv.includes("--json"), argv.includes("--print-hook")),
  read: (argv) => {
    // §14 Phase 6. `--print-hook` explains the trade before a developer opts in.
    if (argv.includes("--print-hook")) {
      printRetrievalHook();
      return Promise.resolve(0);
    }
    return read(argv[0]);
  },
  statusline: (argv) => statusline(argv),
  doctor: () => doctor(),
};

const name = process.argv[2] ?? "help";
const handler = commands[name];

if (handler === undefined) {
  process.stdout.write(USAGE);
  process.exit(name === "help" || name === "--help" ? 0 : 1);
}

try {
  process.exit(await handler(process.argv.slice(3)));
} catch (error) {
  // Neither of the two machine-invoked paths may print to a developer's terminal:
  // the statusline renders into their prompt, and the summary's stdout is parsed as
  // JSON by a hook.
  if (name === "statusline" || name === "summary") process.exit(0);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
