/**
 * Obrigado's VS Code surface, which Cursor inherits by being a fork.
 *
 * The whole extension is one `StatusBarItem`. That is a documented API — persistent text,
 * a tooltip, and a command on click — and using it means no other extension's bundle is
 * read, rewritten, or re-signed, and no Content-Security-Policy is relaxed. Staying within
 * the documented API is the security and compatibility boundary (INVARIANT 11, §3).
 *
 * Delivery is not reimplemented. This runs `obrigado statusline --agent <host> --json` and
 * renders the parts, exactly as the OpenCode plugin does. Rotation, batching, beacons and
 * the disclosure stay in the one renderer Claude Code already drives.
 *
 * ── Why this surface bills differently, and where that rule lives ──
 *
 * Every other Obrigado surface lives inside an agent's own UI, so an impression implies an
 * agent was running: that is what §14's viewability rules are written against. A status
 * bar item is visible whenever the window is, including while somebody is reading code
 * with no agent involved. Billing that as an agent impression would be counting inventory
 * we did not sell.
 *
 * A21 settles it session-scoped: an editor impression counts only while the client's own
 * per-agent session state shows a recent render. This extension therefore does nothing
 * special. It runs `statusline` like every other host, and the gate there returns nothing
 * when no agent is live — so the surface goes dark rather than rendering unbilled. The
 * rule deliberately does NOT live here: one gate in the client governs every editor host,
 * and no extension can opt itself into billing by forgetting to ask.
 *
 * Ambient editor placement — earning whenever the window is visible, priced as its own
 * inventory — stays available and unbuilt. Session-scoped is a strict subset of it, so
 * that order only runs one way.
 */
import { spawn } from "node:child_process";

import { parseSponsored, statuslineArgv, type Sponsored } from "@obrigado/surface";
import * as vscode from "vscode";

import { statusText, tooltipMarkdown } from "./creative.ts";

/** Matches the other hosts. The batch behind this is cached for far longer. */
const REFRESH_MS = 30_000;
const RENDER_TIMEOUT_MS = 2_000;

const OPEN_COMMAND = "obrigado.openSponsor";

/**
 * Which host this is, as the wire records it.
 *
 * Cursor is a VS Code fork and reports its own `appName`, so one extension serves both and
 * the impression still says which editor it rendered in. Guessing "vscode" for a Cursor
 * user would blur two populations that no rollup joins back together.
 */
function host(): string {
  return vscode.env.appName.toLowerCase().includes("cursor") ? "cursor" : "vscode";
}

/**
 * The CLI. `obrigado` on PATH is the installed case; the override exists so this can be
 * developed against a source checkout before the client is published.
 */
function command(): readonly string[] {
  // A setting first, because an editor launched from the Dock inherits no shell
  // environment — the env var works when Cursor is started from a terminal and silently
  // does not otherwise, which is a bad way to find out your configuration was ignored.
  const configured = vscode.workspace.getConfiguration("obrigado").get<string>("statuslineCommand");
  const override =
    configured !== undefined && configured.trim().length > 0
      ? configured
      : process.env["OBRIGADO_STATUSLINE_COMMAND"];
  return statuslineArgv(host(), override);
}

/**
 * Every failure resolves to null, which hides the item.
 *
 * The correct failure for an advertisement: the editor looks exactly as it did before the
 * extension was installed. An error surfaced into someone's status bar would be worse than
 * showing no ad at all.
 */
function fetchSponsored(cwd: string): Promise<Sponsored | null> {
  const [bin, ...args] = command();
  if (bin === undefined) return Promise.resolve(null);

  return new Promise<Sponsored | null>((resolve) => {
    let settled = false;
    const done = (value: Sponsored | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
    // Fires only when the child has produced no line in time. A child that answered is
    // still shipping the impression it just rendered, and must not be killed for it.
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, RENDER_TIMEOUT_MS);

    // The FIRST complete line settles the render. The renderer prints its line and then
    // ships beacons before exiting, and waiting for `close` made the render budget and the
    // beacon budget one budget: a slow network meant the status bar drew nothing for an
    // impression that was already queued.
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const newline = out.indexOf("\n");
      if (newline === -1) return;
      const line = out.slice(0, newline).trim();
      if (line.length === 0) {
        out = out.slice(newline + 1);
        return;
      }
      clearTimeout(timer);
      done(parseSponsored(line));
    });
    child.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.split("\n").find((value) => value.trim().length > 0);
      done(line === undefined ? null : parseSponsored(line.trim()));
    });

    // One session per window per workspace, not one per machine. A constant id made every
    // window share a single cached batch: the first window's dependencies decided the
    // fingerprint and the ads, and every other window reported impressions against it, so
    // its own dependencies were never funded. `env.sessionId` is unique to this editor
    // process; the workspace path tells two windows of one process apart.
    child.stdin.end(
      JSON.stringify({ session_id: `${host()}-${vscode.env.sessionId}-${cwd}`, cwd }),
    );
  });
}

export function activate(context: vscode.ExtensionContext): void {
  // Left-aligned and low priority: the right side is where language servers and problem
  // counts live, and a sponsored line should not compete with the editor's own state.
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100);
  let current: Sponsored | null = null;
  // Everything disposable, registered once. The interval is wrapped so it is torn down by
  // the same mechanism as the rest rather than needing its own deactivate() path.
  context.subscriptions.push(
    item,
    vscode.commands.registerCommand(OPEN_COMMAND, async () => {
      // The signed /c/:token URL, never the advertiser's destination directly — the
      // redirect is what records the click and sanitises where it lands.
      if (current !== null) await vscode.env.openExternal(vscode.Uri.parse(current.url));
    }),
    { dispose: () => clearInterval(timer) },
  );

  const refresh = async (): Promise<void> => {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    current = await fetchSponsored(cwd);
    if (current === null) {
      item.hide();
      return;
    }
    // The label is part of the text and never separated from the copy: there is no state
    // in which the advertisement is visible and the disclosure is not (§3).
    item.text = statusText(current);
    // A MarkdownString, not a plain one — the hover is the only surface here that renders
    // anything richer than text without costing a click. `isTrusted` stays off: it is what
    // enables `command:` links, and none of this needs them.
    item.tooltip = new vscode.MarkdownString(tooltipMarkdown(current));
    item.command = OPEN_COMMAND;
    item.show();
  };

  const timer = setInterval(() => void refresh(), REFRESH_MS);
  void refresh();
}

export function deactivate(): void {
  // Nothing to tear down: every disposable is owned by `context.subscriptions`.
}
