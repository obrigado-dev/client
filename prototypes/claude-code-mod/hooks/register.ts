/**
 * Obrigado's Claude Code mod. Parked: see the README for why, and for what picking it up takes.
 *
 * Claude Code v2.1.287 made mods generally available: a plugin with a hooks module that Claude
 * Code calls when events happen, including each time it draws its own interface. One of the
 * places it draws is the band directly above the prompt, the documented `AbovePrompt` render
 * site, which every mod shares and which the terminal and the Desktop app's Code tab both
 * raise. It is persistent and it is the host's, which is the bar `docs/ADDING-A-SURFACE.md`
 * sets for a surface.
 *
 * This draws in the app and nowhere else. The terminal keeps the status line, and the split
 * follows what each can do. In the terminal the band can be collapsed (`ctrl+x ctrl+a`, or its
 * `[-]`), after which Claude Code goes on asking this hook to draw with the same props, so a
 * line counted there may be a line nobody saw; the status line cannot be collapsed, and it
 * carries the turn timing the classifier reads. The app's band has no way to collapse it. So a
 * session gets one line, from whichever of the two can count it honestly.
 *
 * Not `$.ui.status`, although that is the call named like a status line: every line a mod pins
 * there starts with `⚠` and the mod's name. A sponsored line drawn as a warning is what A5's
 * palette rules forbid, and the reason the session summary stays out of `systemMessage` too.
 *
 * Delivery is not reimplemented here, as in every other host. This runs `obrigado statusline
 * --agent claude-code-mod --json` and draws the parts it is handed; rotation, batching,
 * beacons, dwell and the disclosure all stay in the one renderer.
 *
 * Why it is parked rather than a surface:
 *
 *   - A mod earlier in the chain receives our tree after the renderer has counted the line, and
 *     may drop it.
 *   - The payload carries no turn timing. Claude Code hands its status line
 *     `cost.total_duration_ms` and `cost.total_api_duration_ms`; the mods API has neither.
 *   - That the app's band cannot be collapsed was seen on 2.1.288, not promised anywhere. A
 *     version that adds a way would put the terminal's problem back (anthropics/claude-code#98986).
 */
import { sponsoredRow } from "./line.ts";
import type { RowElements } from "./line.ts";
import { parseSponsored, statuslineArgv } from "./surface.ts";
import type { Sponsored } from "./surface.ts";

const AGENT = "claude-code-mod";

/** This mod's own version, reported on every render (A30). Held to both manifests by a test. */
const SURFACE_VERSION = "0.1.0";

/** The other hosts' cadence. Each tick is a process spawn; the batch behind it lives far longer. */
const REFRESH_MS = 30_000;

/**
 * How long the renderer may take.
 *
 * Longer than the OpenCode plugin's two seconds because this waits for the whole run, not the
 * first line: `$.process.run` resolves on exit, after the beacons have shipped. Nothing waits on
 * it but the next tick, so a slow network delays a line rather than the session.
 */
const RENDER_TIMEOUT_MS = 10_000;

/*
 * The parts of the mods API this module uses.
 *
 * Claude Code writes its full declarations into `.claude-plugin/types/` when it loads the mod,
 * for whichever version loaded it, so they are not in the repository. The gate types the module
 * against this subset; `claude plugin validate` checks the calls against the engine itself.
 */

interface Timer {
  cancel(): void;
}

interface BandEvent {
  readonly surface: string;
  readonly props: { readonly hasSurvey: boolean };
}

interface Mods<Node = unknown> {
  readonly clock: {
    after(ms: number, fn: () => void): Timer;
    every(ms: number, fn: () => void): Timer;
  };
  readonly env: { get(name: string): Promise<string | undefined> };
  readonly process: {
    run(
      argv: readonly string[],
      init: { readonly stdin: string; readonly timeoutMs: number },
    ): Promise<{ readonly exitCode: number; readonly stdout: string }>;
  };
  readonly session: {
    id(): Promise<string>;
    cwd(): Promise<string>;
    surfaces(): Promise<readonly string[]>;
  };
  readonly ui: {
    invalidate(event: "ui.render"): void;
    resolve(e: BandEvent): RowElements<Node>;
  };
}

type Hook<E, R> = ($: Mods, e: E, next: (e: E) => Promise<R>) => Promise<R>;

interface On {
  (event: "session.start" | "session.end" | "session.attach", hook: Hook<unknown, unknown>): void;
  (event: "ui.render", matcher: { component: "AbovePrompt" }, hook: Hook<BandEvent, unknown>): void;
}

/** The line on screen, or null for none. Every failure lands here as null. */
let sponsored: Sponsored | null = null;
let ticking: Timer | null = null;

/**
 * One render, as the other hosts do it: the payload Claude Code would send its status line,
 * cut to what the renderer reads, and the first non-empty line of what comes back.
 *
 * Every failure is null, which draws nothing: Claude Code looks exactly as it did before the
 * mod was installed, which beats an error in somebody's prompt area.
 */
async function render($: Mods): Promise<Sponsored | null> {
  const [command, ...args] = statuslineArgv(AGENT, await $.env.get("OBRIGADO_STATUSLINE_COMMAND"));
  if (command === undefined) return null;
  try {
    const { stdout } = await $.process.run([command, ...args], {
      stdin: JSON.stringify({
        session_id: await $.session.id(),
        cwd: await $.session.cwd(),
        surface_version: SURFACE_VERSION,
      }),
      timeoutMs: RENDER_TIMEOUT_MS,
    });
    const line = stdout.split("\n").find((candidate) => candidate.trim().length > 0);
    return line === undefined ? null : parseSponsored(line);
  } catch {
    return null;
  }
}

/**
 * Whether this session is the app's alone: drawn in the app and in no terminal.
 *
 * A terminal session the app has attached to is still the terminal's. Its status line is already
 * on screen, and one session shows one line. `surfaces()` lists the terminal first wherever
 * there is one, so the test is simply whether it is there.
 */
async function appOnly($: Mods): Promise<boolean> {
  const surfaces = await $.session.surfaces();
  return surfaces.includes("desktop") && !surfaces.includes("terminal");
}

/** Asks for a line only in a session that is the app's; anywhere else there is none to count. */
async function refresh($: Mods): Promise<void> {
  sponsored = (await appOnly($)) ? await render($) : null;
  $.ui.invalidate("ui.render");
}

export function register(on: On): void {
  on("session.start", ($, e, next) => {
    // `session.start` fires again on every reload of the module: one interval, not one per save.
    ticking?.cancel();
    ticking = $.clock.every(REFRESH_MS, () => {
      void refresh($);
    });
    // The first line now rather than a tick from now, without holding up the session's start.
    $.clock.after(1, () => {
      void refresh($);
    });
    return next(e);
  });

  // The app connecting is the moment a session becomes one this draws in, so the first line comes
  // then rather than at the next tick.
  on("session.attach", ($, e, next) => {
    $.clock.after(1, () => {
      void refresh($);
    });
    return next(e);
  });

  on("session.end", (_, e, next) => {
    ticking?.cancel();
    ticking = null;
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    // What the mods after this one draw. Returned as-is when there is nothing of ours to add,
    // and kept beneath our row otherwise: a tree of our own would replace theirs.
    const theirs = await next(e);
    // A survey holds the band, and a hook yields to it. And only the app's band is ours.
    if (sponsored === null || e.props.hasSurvey || e.surface !== "desktop") return theirs;
    const { Box, Text, Link, Svg } = $.ui.resolve(e);
    return Box({
      flexDirection: "column",
      children: [sponsoredRow(sponsored, { Text, Link, Box, Svg }), theirs],
    });
  });
}
