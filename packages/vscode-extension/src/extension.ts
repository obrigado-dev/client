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
 * ── The open question, which is a PRODUCT question and not a technical one ──
 *
 * Every other Obrigado surface lives inside an agent's own UI, so an impression implies an
 * agent was running: that is what §14's viewability rules are written against. A status
 * bar item is visible whenever the window is, including while somebody is reading code
 * with no agent involved. Billing that as an agent impression would be counting inventory
 * we did not sell.
 *
 * So this extension DISPLAYS but does not yet BILL: it renders whatever the client hands
 * it and does not enqueue an impression of its own. Wiring the beacon up needs an answer
 * to "what counts as an agent session in an editor", and the honest candidates are:
 *
 *   - only while an agent CLI is running in the integrated terminal, which is detectable
 *     but fragile;
 *   - only while the client's own per-agent session state shows a recent render, which is
 *     evidence we already collect and do not currently expose;
 *   - a separate, honestly-labelled editor placement, priced as its own inventory.
 *
 * Picking one is a spec decision. Guessing here would put revenue behind a definition
 * nobody wrote down.
 */
import { spawn } from "node:child_process";

import * as vscode from "vscode";

import { statusText, tooltipMarkdown, type Sponsored } from "./creative.ts";

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
      ? configured.trim()
      : process.env["OBRIGADO_STATUSLINE_COMMAND"];
  const base =
    override !== undefined && override.length > 0
      ? override.split(" ")
      : ["obrigado", "statusline"];
  return [...base, "--agent", host(), "--json"];
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
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, RENDER_TIMEOUT_MS);

    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const line = out.split("\n").find((value) => value.trim().length > 0);
        if (line === undefined) return done(null);
        const parsed = JSON.parse(line) as Partial<Sponsored>;
        const { label, copy, url } = parsed;
        // All three or nothing: copy without its label is an undisclosed advertisement,
        // and copy without a URL is an impression nobody can act on.
        if (typeof label !== "string" || typeof copy !== "string" || typeof url !== "string") {
          return done(null);
        }
        if (label.length === 0 || copy.length === 0 || url.length === 0) return done(null);
        const { spans, style, effect, brand } = parsed as Partial<Sponsored>;
        done({
          label,
          copy,
          url,
          // A brand needs a name to be a brand. A malformed one is dropped rather than
          // rendered half-way, because the alt text for the logo IS the name.
          brand:
            brand !== null && brand !== undefined && typeof brand.name === "string"
              ? { name: brand.name, logo: typeof brand.logo === "string" ? brand.logo : null }
              : null,
          // Styling is optional on the wire: an older client that sends none still renders,
          // as one unstyled link over the whole line.
          spans: Array.isArray(spans) && spans.length > 0 ? spans : [{ text: copy, link: true }],
          style: typeof style === "string" ? style : "default",
          effect: typeof effect === "string" ? effect : "none",
        });
      } catch {
        done(null);
      }
    });

    child.stdin.end(JSON.stringify({ session_id: `${host()}-window`, cwd }));
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
