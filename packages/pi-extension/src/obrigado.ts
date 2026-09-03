/**
 * Obrigado's Pi surface.
 *
 * Pi's footer is composed from KEYED entries: an extension calls `ctx.ui.setStatus(key, text)`,
 * and the host sorts every extension's entry by key, joins them with a space, and draws the
 * result under its own pwd and token-stats lines. Ours is one of those entries. It sits beside
 * the developer's other statuses rather than replacing anything, and clearing it restores the
 * footer exactly — there is nothing of theirs to hand back.
 *
 * `ctx.ui.setFooter` also exists, and it is the trap. It replaces the built-in footer entirely,
 * so an ad taking that route would be deleting the model name, the context gauge and the working
 * directory to make room for itself. That is the spinner-verb mistake in another costume: a
 * surface is only ours when the host offers it, and Pi offers this one.
 *
 * Delivery is not reimplemented here. `obrigado statusline --agent pi` already does rotation,
 * batching, beacons, dwell and the disclosure, and it returns a finished ANSI line — which is
 * exactly what `setStatus` accepts. Unlike OpenCode, which needs `--json` because OpenTUI
 * composes a real link element from parts, Pi's footer is a string, so the one renderer every
 * other host drives is the whole integration. A second delivery path is how hosts begin to
 * disagree about what was shown and what was billed.
 */

/**
 * Which host this copy was installed into.
 *
 * `obrigado install` rewrites this single line when it writes the file into oh-my-pi's
 * extensions directory. It is not cosmetic: the agent namespaces session state, so two hosts
 * running side by side cannot consume each other's batch, and it rides the impression so
 * revenue attributes to the host that actually drew the line.
 */
const AGENT = "pi";

/** The key our entry occupies in the host's footer map. Stable, so refreshes replace in place. */
const STATUS_KEY = "obrigado";

/** A spawn that outlives its usefulness is a spawn holding up the footer. */
const TIMEOUT_MS = 2_000;

/**
 * Pi's own types, structurally.
 *
 * `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"` is what the upstream
 * examples do, and jiti erases type imports before the file ever runs — but this file is COPIED
 * into a developer's extensions directory, where that package may not be resolvable by an
 * editor even though the host resolves it fine. Describing the three calls used here keeps the
 * copy self-contained: it type-checks wherever it lands, and it cannot drift into using an API
 * that was never verified against the host.
 */
interface StatusUi {
  setStatus(key: string, text: string | undefined): void;
}

interface ExtensionContext {
  readonly ui: StatusUi;
  readonly hasUI: boolean;
  readonly cwd: string;
  readonly sessionManager: { getSessionId(): string };
}

interface ExtensionApi {
  on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
}

/**
 * How this copy invokes the renderer.
 *
 * `obrigado install` rewrites this line too, for the same reason Claude Code's installer writes
 * an absolute `<bun> …/cli.ts` into `settings.json` when the CLI is not on PATH: an extension
 * that spawns a command the shell cannot find fails the quiet way — no line, no error, nothing
 * to debug. Install is when the answer is known, so install is where it is decided.
 */
const COMMAND = "obrigado statusline";

/** The environment override still wins, for running against a checkout without reinstalling. */
function statuslineCommand(): readonly string[] {
  const override = process.env["OBRIGADO_STATUSLINE_COMMAND"];
  const base = override !== undefined && override.trim().length > 0 ? override : COMMAND;
  return [...splitCommand(base), "--agent", AGENT];
}

/**
 * A command, split the way a shell would split it — quotes and all.
 *
 * A deliberate COPY of `@obrigado/surface`'s `splitCommand`: this file is copied into a
 * developer's extensions directory and must stand alone, so it cannot import the package the
 * other hosts share. `test/extension.test.ts` holds the two to the same behaviour. Exported for
 * that test and nothing else.
 */
export function splitCommand(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else if (character === "\\" && quote === '"' && index + 1 < text.length) {
        index += 1;
        current += text[index] ?? "";
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      inToken = true;
    } else if (character === "\\" && index + 1 < text.length) {
      index += 1;
      current += text[index] ?? "";
      inToken = true;
    } else if (/\s/u.test(character)) {
      if (inToken) out.push(current);
      current = "";
      inToken = false;
    } else {
      current += character;
      inToken = true;
    }
  }
  if (inToken) out.push(current);
  return out;
}

/**
 * The payload the renderer expects on stdin.
 *
 * Deliberately the shape Claude Code sends, because the renderer keys per-session state off
 * `session_id`. Omitting it would collapse every Pi window into one shared rotation cursor, so
 * two sessions would consume each other's inventory.
 */
function payloadFor(sessionId: string, cwd: string): string {
  return JSON.stringify({ session_id: sessionId, cwd });
}

/**
 * The environment the renderer runs in, with hyperlinks turned OFF.
 *
 * This is the one place Pi's surface differs from every other terminal host, and it is a
 * deliberate refusal rather than a missing feature. Pi's footer truncates the joined status
 * line to the terminal width, and its truncator stops at the first grapheme that would overflow
 * — dropping every ANSI segment after that point and appending only an SGR reset. An OSC 8
 * hyperlink OPENED before the cut therefore never gets its closing sequence, and a terminal
 * that honours OSC 8 keeps applying that URL to whatever is drawn next.
 *
 * The failure is not a lost link. It is the advertiser's URL silently attached to unrelated
 * parts of the developer's UI, which is exactly the kind of bleed §3 exists to prevent. So the
 * copy renders coloured and unclickable here, and the trailing domain in the creative stays the
 * way a reader acts on it. `OBRIGADO_HYPERLINKS` is the documented override for precisely this
 * case: "turning it off if a rendering bug appears".
 */
function spawnEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env["OBRIGADO_HYPERLINKS"] = "0";
  return env;
}

/**
 * Every failure returns null, which leaves the footer alone.
 *
 * That is the correct failure for an advertisement: Pi looks exactly as it did before the
 * extension was installed. An error surfaced into the developer's chrome would be a worse
 * outcome than showing no ad.
 */
async function fetchLine(sessionId: string, cwd: string): Promise<string | null> {
  const [command, ...args] = statuslineCommand();
  if (command === undefined) return null;

  const { spawn } = await import("node:child_process");
  return await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // oxlint-disable-next-line promise/no-multiple-resolved -- `settled` above is the guard; every path funnels through here exactly once
      resolve(value);
    };

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "ignore"],
      env: spawnEnvironment(),
    });
    // Fires only when the child has produced no line in time. A child that answered is still
    // shipping the impression it just rendered, and must not be killed for it.
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, TIMEOUT_MS);

    // The FIRST complete line settles the render. The renderer prints its line and then ships
    // beacons before exiting, and waiting for `close` made the render budget and the beacon
    // budget one budget: a slow network meant the footer drew nothing for an impression that
    // was already queued.
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      const newline = out.indexOf("\n");
      if (newline === -1) return;
      const line = out.slice(0, newline);
      if (line.trim().length === 0) {
        out = out.slice(newline + 1);
        return;
      }
      finish(line.trimEnd());
    });
    child.on("error", () => {
      finish(null);
    });
    child.on("close", () => {
      const line = out.split("\n").find((value) => value.trim().length > 0);
      finish(line === undefined || line.trim().length === 0 ? null : line.trimEnd());
    });

    child.stdin.on("error", () => {
      finish(null);
    });
    child.stdin.end(payloadFor(sessionId, cwd));
  });
}

export default function (pi: ExtensionApi): void {
  /*
   * One render at a time.
   *
   * `turn_end` can arrive while a previous spawn is still running — a fast turn, or a machine
   * under load — and two concurrent renders would each advance the rotation cursor, burning an
   * impression the developer never saw. The guard is the cheapest correct answer: skip, and let
   * the next turn refresh.
   */
  let rendering = false;

  const refresh = async (ctx: ExtensionContext): Promise<void> => {
    /*
     * Print mode, JSON mode and subagents have no footer to draw into, and `hasUI` is how the
     * host says so. Returning here is what keeps those runs from counting as impressions: an
     * ad nobody could have seen must not be billed, and the cheapest way to guarantee that is
     * to never ask for one.
     */
    if (!ctx.hasUI) return;
    if (rendering) return;
    rendering = true;
    try {
      const line = await fetchLine(ctx.sessionManager.getSessionId(), ctx.cwd);
      if (line !== null) ctx.ui.setStatus(STATUS_KEY, line);
    } catch {
      // A broken render leaves the previous line in place rather than clearing the footer.
    } finally {
      rendering = false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await refresh(ctx);
  });

  /*
   * A turn is the honest cadence. It ties each render to the developer actually finishing a
   * piece of work and looking at the footer, rather than to a wall clock that would keep
   * rotating inventory past an idle terminal.
   */
  pi.on("turn_end", async (_event, ctx) => {
    await refresh(ctx);
  });

  /* Ours goes when the session does, so nothing is left behind in a footer we no longer own. */
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
