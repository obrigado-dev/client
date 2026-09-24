import { formatUsd, microsFromWire } from "@obrigado/shared/money";
import type { DepEntry } from "@obrigado/shared";

import { fetchStats } from "../api.ts";
import { droppedEvents, queueDepth } from "../beacon.ts";
import {
  claudeIntegration,
  codexIntegration,
  opencodeIntegration,
  QUEUE_PATH,
  readConfig,
  SESSION_STATE_DIR,
} from "../config.ts";
import { codexSupport } from "../codex-statusline.ts";
import { hasOurPlugin, OPENCODE_TUI_CONFIG_PATH, readTuiConfig } from "../opencode-plugin.ts";
import { resolveDeps } from "../deps.ts";
import { supportsHyperlinks } from "../link.ts";
import { sessionStateSummary } from "../session-state.ts";
import { isOurStatusLine, readSettings } from "../statusline.ts";
import { apiOrigin } from "./shared.ts";

/** How many local dependencies to list. Enough to recognise the project, not a manifest. */
const LOCAL_PREVIEW = 12;

/**
 * What this workspace is made of.
 *
 * It used to rank the packages this install had funded and what each one got. A36 ended
 * per-package allocation, so the honest version is the one this always fell back to: the
 * dependency set an advertiser is buying reach into, read off the lockfile on this machine.
 */
function printPackages(deps: readonly DepEntry[]): void {
  console.log("\n  This workspace depends on:");
  for (const dep of deps.slice(0, LOCAL_PREVIEW)) console.log(`    ${dep.p}`);
  if (deps.length > LOCAL_PREVIEW) console.log(`    … and ${deps.length - LOCAL_PREVIEW} more`);
}

/**
 * `obrigado status` (§14 Phase 1).
 *
 * The figures §14 names — "this period's contribution, session count, lifetime total" —
 * above the local diagnostics. That order
 * is the point: this is the retention surface, and the install pitch is "see which
 * projects your work funded", not "see whether your statusline hook is wired up".
 *
 * Everything below the money still prints when the server is unreachable, because
 * the local half is the half that answers "is it working".
 */
export async function status(): Promise<number> {
  const config = await readConfig();
  if (config === null) {
    console.log("Obrigado is not installed. Run `obrigado install`.");
    return 1;
  }

  const origin = apiOrigin(config);
  const [settings, tuiConfig, runtime, workspace, stats] = await Promise.all([
    readSettings().catch(() => null),
    readTuiConfig().catch(() => null),
    sessionStateSummary(),
    resolveDeps(),
    fetchStats({ apiOrigin: origin, installKey: config.install_key }),
  ]);

  console.log("Obrigado\n");

  if (stats === null) {
    console.log(`  Contribution  unavailable — could not reach ${origin}`);
  } else {
    const period = formatUsd(microsFromWire(stats.period_micros));
    const lifetime = formatUsd(microsFromWire(stats.lifetime_micros));
    console.log(`  This month    ${period}  (${stats.period}, accrued)`);
    console.log(`  All time      ${lifetime}  across ${stats.package_count} packages`);
    console.log(`  Impressions   ${stats.impressions}`);
  }

  console.log(`  Workspace     ${workspace.deps.length} packages (from ${workspace.source})`);
  console.log(
    `  Claude Code   ${isOurStatusLine(settings?.["statusLine"]) ? "configured" : "not installed"}`,
  );
  console.log(`  OpenCode      ${hasOurPlugin(tuiConfig) ? "configured" : "not installed"}`);
  console.log(`  Codex         unsupported upstream (${codexSupport().issue})`);
  console.log(`  API           ${origin}`);

  console.log(
    `  Runtime state ${runtime.sessions} session(s), ${runtime.batches} batch(es), ${runtime.pending} pending`,
  );

  console.log(`  Beacon queue  ${await queueDepth()} pending`);

  // Dropped impressions are lost revenue, so they are surfaced where a human is already
  // looking for trouble. The statusline path cannot say it — anything it writes to stderr
  // lands in the developer's terminal on every repaint.
  const dropped = await droppedEvents();
  if (dropped.length > 0) {
    const total = dropped.reduce((sum, entry) => sum + entry.count, 0);
    const latest = dropped.at(-1);
    console.log(
      `  Dropped       ${total} event(s) the server rejected as invalid` +
        `${latest === undefined ? "" : ` — last HTTP ${latest.status} at ${latest.at}`}`,
    );
    console.log("                They could never have been accepted; keeping them would have");
    console.log("                blocked every later impression. This is worth reporting.");
  }
  console.log(
    `  Chained       ${claudeIntegration(config)?.chained_command === undefined ? "no" : "yes — your statusline renders above ours"}`,
  );
  console.log(
    `  Clickable     ${supportsHyperlinks() ? "yes (Cmd/Ctrl+click)" : "no — this terminal has no OSC 8 support"}`,
  );

  printPackages(workspace.deps);

  console.log("\n  70% of gross revenue from these impressions funds open source maintainers.");
  console.log(`  Every grant is published: ${origin}/transparency`);
  return 0;
}

/**
 * What `/health` actually says, as one line.
 *
 * Reachable and serving are DIFFERENT FACTS, and conflating them cost a real debugging
 * session: the server answered 200 while `serving` was false, `doctor` reported "reachable",
 * and the only visible symptom was a status line that had quietly stopped appearing. A
 * developer in that position has nowhere else to look — the client cannot tell a server
 * that is refusing to serve from one with no campaigns to serve.
 *
 * So the reason travels too. "Not serving" alone would send someone hunting; "killswitch
 * unreadable: Max lifetime timeout reached after 30m" ends the search.
 */
export function describeServing(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "unknown — no health payload";
  const { serving, reason } = payload as { serving?: unknown; reason?: unknown };
  if (serving === true) return "yes";
  const because =
    typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : "no reason reported";
  return `NO — ${because}`;
}

export async function doctor(): Promise<number> {
  // Non-zero when something a person would want to fix was found. `doctor` exists to detect
  // an unreadable settings file and an unreachable server, and it used to exit 0 for both —
  // so a script wrapping it could not tell a healthy install from a broken one.
  let healthy = true;
  const config = await readConfig();
  const tuiConfig = await readTuiConfig().catch(() => null);
  const settings = await readSettings().catch((error: unknown) => {
    console.log(`  settings.json  UNREADABLE — ${error instanceof Error ? error.message : error}`);
    healthy = false;
    return null;
  });

  const statusLine = settings?.["statusLine"];
  const owner = isOurStatusLine(statusLine)
    ? "obrigado"
    : statusLine === undefined
      ? "unset"
      : "other tool";

  console.log("obrigado doctor\n");
  console.log(`  config         ${config === null ? "missing" : "present"}`);
  console.log(
    `  install key    ${config === null ? "none" : `${config.install_key.slice(0, 8)}…`}`,
  );
  console.log(
    `  settings.json  ${settings === null ? "absent" : `${Object.keys(settings).length} keys`}`,
  );
  console.log(`  statusLine     ${owner}`);
  console.log(`  chained        ${claudeIntegration(config)?.chained_command ?? "none"}`);
  console.log(`  codex          ${codexSupport().reason}; see ${codexSupport().issue}`);
  console.log(
    `  opencode       ${hasOurPlugin(tuiConfig) ? `plugin entry in ${OPENCODE_TUI_CONFIG_PATH}` : "not configured"}`,
  );
  console.log(
    `  integrations   Claude ${claudeIntegration(config)?.installed === true ? "on" : "off"}, Codex ${codexIntegration(config)?.installed === true ? "on" : "off"}, OpenCode ${opencodeIntegration(config)?.installed === true ? "on" : "off"}`,
  );
  console.log(`  hyperlinks     ${supportsHyperlinks() ? "supported" : "not supported"}`);
  console.log(`  session state  ${SESSION_STATE_DIR}`);
  console.log(`  beacon queue   ${QUEUE_PATH} (${await queueDepth()} pending)`);

  const dropped = await droppedEvents();
  console.log(
    `  dropped        ${
      dropped.length === 0
        ? "none"
        : `${dropped.reduce((sum, entry) => sum + entry.count, 0)} event(s) rejected as invalid — see \`obrigado status\``
    }`,
  );

  const origin = apiOrigin(config);
  try {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) {
      console.log(`  server         HTTP ${response.status} at ${origin}`);
      return 1;
    }
    console.log(`  server         reachable at ${origin}`);
    const payload: unknown = await response.json().catch(() => null);
    console.log(`  serving        ${describeServing(payload)}`);
  } catch {
    console.log(`  server         unreachable at ${origin}`);
    healthy = false;
  }
  return healthy ? 0 : 1;
}
