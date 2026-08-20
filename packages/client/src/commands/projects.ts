/**
 * `obrigado projects`, `obrigado share`, and `obrigado summary` (§14 Phase 1).
 *
 * "This output is the artifact people screenshot. Treat its design with the same
 * care as the landing page." So the money is right-aligned, the widest package name
 * sets the column, and nothing is printed that a developer would have to explain.
 *
 * Every command here degrades to something useful offline. §14 makes this the
 * retention mechanic; a retention mechanic that prints a stack trace on a train is
 * not one.
 */
import { changeShare, fetchStats } from "../api.ts";
import { readConfig } from "../config.ts";
import { recordRead } from "../retrieval.ts";
import { resolveDeps } from "../deps.ts";
import { apiOrigin } from "./shared.ts";
import type { FundedPackageWire } from "@obrigado/shared";
import { formatUsd, microsFromWire } from "@obrigado/shared/money";

/** Right-align money against the widest value so the column reads as a column. */
function table(entries: readonly FundedPackageWire[]): string[] {
  const rows = entries.map((entry) => ({
    name: entry.package_id,
    depth: entry.depth === 0 ? "direct" : `depth ${entry.depth}`,
    money: formatUsd(microsFromWire(entry.share_micros)),
  }));

  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  const moneyWidth = Math.max(...rows.map((row) => row.money.length));

  return rows.map(
    (row, index) =>
      `  ${String(index + 1).padStart(4)}  ${row.name.padEnd(nameWidth)}  ` +
      `${row.money.padStart(moneyWidth)}  ${row.depth}`,
  );
}

export async function projects(): Promise<number> {
  const config = await readConfig();
  if (config === null) {
    console.log("Obrigado is not installed. Run `obrigado install`.");
    return 1;
  }

  const origin = apiOrigin(config);
  const stats = await fetchStats({ apiOrigin: origin, installKey: config.install_key });

  if (stats === null) {
    // Offline: the dependency list is local, so the *names* are still answerable
    // even when the amounts are not. Saying so beats printing nothing.
    const { deps, source } = await resolveDeps();
    console.log(`Could not reach ${origin}. Showing this workspace's dependencies only.\n`);
    console.log(`  ${deps.length} packages (from ${source})\n`);
    for (const dep of deps) {
      console.log(`  ${dep.p}${dep.d === 0 ? "" : `  depth ${dep.d}`}`);
    }
    return 1;
  }

  if (stats.funded.length === 0) {
    console.log("No projects funded yet — this install has not served an impression.");
    console.log("Run Claude Code in a project with a lockfile and check back.");
    return 0;
  }

  console.log(`Projects this install has funded — ${stats.funded.length} packages\n`);
  for (const line of table(stats.funded)) console.log(line);

  console.log(
    `\n  ${formatUsd(microsFromWire(stats.lifetime_micros))} total, across ` +
      `${stats.sessions} ${stats.sessions === 1 ? "session" : "sessions"}.`,
  );
  console.log("  Amounts are each package's share of the 70% pool, weighted by dependency depth.");
  if (stats.share_url !== undefined) console.log(`  Shareable page: ${stats.share_url}`);
  return 0;
}

const SHARE_USAGE = `obrigado share — a public page for what this install funds

  obrigado share            show the current link, if there is one
  obrigado share create     issue a link (replaces any existing one)
  obrigado share revoke     make the current link stop resolving

The page carries no account, hostname, IP, repository name, or date finer than a
month, and names a package only once enough separate installations report it.
`;

export async function share(action?: string): Promise<number> {
  const config = await readConfig();
  if (config === null) {
    console.log("Obrigado is not installed. Run `obrigado install`.");
    return 1;
  }

  const origin = apiOrigin(config);
  const options = { apiOrigin: origin, installKey: config.install_key };

  if (action === undefined || action === "show") {
    const stats = await fetchStats(options);
    if (stats === null) {
      console.log(`Could not reach ${origin}.`);
      return 1;
    }
    if (stats.share_url === undefined) {
      console.log("This install has no shareable page. Run `obrigado share create` to make one.");
      return 0;
    }
    console.log(`  ${stats.share_url}`);
    console.log("\n  Revoke it with `obrigado share revoke`.");
    return 0;
  }

  if (action === "create") {
    const result = await changeShare(options, "issue");
    if (result?.share_url === undefined) {
      console.log(`Could not reach ${origin}.`);
      return 1;
    }
    console.log(`  ${result.share_url}\n`);
    console.log("  Anyone with this link can see it. Revoke with `obrigado share revoke`.");
    console.log("  Creating a new link replaces this one — the old URL stops resolving.");
    return 0;
  }

  if (action === "revoke") {
    const result = await changeShare(options, "revoke");
    if (result === null) {
      console.log(`Could not reach ${origin}.`);
      return 1;
    }
    console.log(
      result.revoked ? "  Revoked. That URL no longer resolves." : "  There was no link to revoke.",
    );
    return 0;
  }

  console.log(SHARE_USAGE);
  return 1;
}

/**
 * The end-of-session summary (§14 Phase 1: "This session helped fund 12 projects.").
 *
 * Prints one line and nothing else, because its only consumer is a hook whose output
 * is a single message. See `docs/SPEC-AMENDMENTS.md` A7 for why delivery of that line
 * is not something the client can guarantee.
 *
 * `--json` emits the `systemMessage` envelope a Claude Code hook needs; bare output
 * is for a developer running it by hand or wiring it into their own shell.
 */
/**
 * `obrigado read <path>` — the retrieval hook target (§14 Phase 6).
 *
 * Invoked by a `PostToolUse` hook on the read tools. Resolves the path to a package LOCALLY
 * and queues only the package id; a path that does not resolve to a package is dropped
 * entirely, because "somewhere in the project" is exactly the private part.
 *
 * Always exits 0 and prints nothing. This runs inside the agent's tool loop, and a retrieval
 * hook that fails loudly has broken something far more important than a payout multiplier.
 */
export async function read(path: string | undefined): Promise<number> {
  if (path === undefined || path.length === 0) return 0;
  const config = await readConfig();
  // Opt-out honoured here too: a developer who turned the summary off has said they do not
  // want this client doing extra work on their machine.
  if (config === null) return 0;
  await recordRead(path);
  return 0;
}

/**
 * The retrieval hook config, printed for the same reason as the summary hook.
 *
 * `statusline.ts` rule 1 — exactly one key in one file — is worth more than the convenience,
 * and A7 records the full argument.
 */
export function printRetrievalHook(): void {
  const command = process.env["OBRIGADO_STATUSLINE_COMMAND"]?.replace(/statusline$/u, "read");

  console.log("Add this to the `hooks` key in ~/.claude/settings.json:\n");
  console.log(
    JSON.stringify(
      {
        hooks: {
          PostToolUse: [
            {
              matcher: "Read|Edit|Grep",
              hooks: [
                {
                  type: "command",
                  command: `${command ?? "obrigado"} read "$CLAUDE_TOOL_INPUT_FILE_PATH"`,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );

  console.log("\n  What this does: when your agent reads a file inside a package, that");
  console.log("  package counts DOUBLE in the month's allocation. Nothing else changes.");
  console.log("\n  What leaves your machine: the package name. Never the path. A path like");
  console.log("  ~/Code/acme-internal/billing/rates.ts names a person, a company and a");
  console.log("  feature, so it is resolved to a package locally and then discarded — and a");
  console.log("  path that is not inside a package is dropped entirely.");
  console.log("\n  Entirely optional. Without it your dependencies are still funded by");
  console.log("  dependency weight alone, and no package is penalised for its absence.");
}

/**
 * The hook config, PRINTED rather than written.
 *
 * `statusline.ts` rule 1 is that exactly one key in one file is ever written:
 * `statusLine`. INVARIANT 11 permits documented hooks, so writing a `hooks` entry
 * would not violate the spec — but it would cost the property that makes rule 1
 * worth having, which is that a reviewer can verify the claim in seconds rather
 * than by reading an argument.
 *
 * And the trade is bad in this specific case, because delivery is unverified.
 * `systemMessage` is documented as universal and user-visible, but `SessionEnd`
 * fires while the session is tearing down and there is no way to confirm from here
 * that the host still renders it. Silently mutating a developer's settings for a
 * line that may never appear is worse than one copy-paste. See A7.
 */
function printHook(): void {
  const command = process.env["OBRIGADO_STATUSLINE_COMMAND"]?.replace(/statusline$/u, "summary");

  console.log("Add this to the `hooks` key in ~/.claude/settings.json:\n");
  console.log(
    JSON.stringify(
      {
        hooks: {
          SessionEnd: [
            { hooks: [{ type: "command", command: `${command ?? "obrigado"} summary --json` }] },
          ],
        },
      },
      null,
      2,
    )
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );

  console.log("\n  Obrigado does not write this for you, deliberately: `obrigado install` touches");
  console.log("  exactly one key (`statusLine`) so that claim stays trivially checkable.");
  console.log("  Turn the line off any time with `obrigado config session_summary false`.");
  console.log("\n  Delivery depends on your agent surfacing a hook's `systemMessage`. If nothing");
  console.log("  appears, `obrigado status` shows the same figures on demand.");
}

export async function summary(asJson: boolean, printHookOnly = false): Promise<number> {
  if (printHookOnly) {
    printHook();
    return 0;
  }
  return await renderSummary(asJson);
}

async function renderSummary(asJson: boolean): Promise<number> {
  const config = await readConfig();
  // Opt-out, per §14. A disabled summary prints nothing at all rather than a
  // message saying it is disabled — the whole point is not adding noise.
  if (config === null || config.session_summary === false) return 0;

  const stats = await fetchStats({
    apiOrigin: apiOrigin(config),
    installKey: config.install_key,
  });
  if (stats === null || stats.funded.length === 0) return 0;

  const count = stats.funded.length;
  const line =
    `This session helped fund ${count} open-source ${count === 1 ? "project" : "projects"} ` +
    `· ${formatUsd(microsFromWire(stats.period_micros))} this month`;

  if (asJson) {
    // `systemMessage` is the one hook field the host shows the user. Anything on
    // stdout goes to the debug log for every event except the three that feed
    // Claude context — see A7.
    console.log(JSON.stringify({ systemMessage: line }));
  } else {
    console.log(line);
  }
  return 0;
}
