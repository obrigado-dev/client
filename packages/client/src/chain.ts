/**
 * Statusline chaining — render the developer's own status line, then ours.
 *
 * Claude Code renders one row per line of output ("each `echo` or `print`
 * statement displays as a separate row"), so two lines is a supported layout
 * rather than a trick.
 *
 * This exists because refusing to install is the wrong end state for a common
 * case. A developer who already has a status line otherwise faces a choice
 * between their own tooling and funding their dependencies — and since they earn
 * nothing from Obrigado, they will correctly pick their own tooling. Chaining
 * makes it not a choice.
 *
 * It is still not patching: their command is stored verbatim in
 * `~/.obrigado/config.json` and executed as-is. We add a line; we do not alter
 * what theirs prints.
 */

/** A slow user command must not stall the status line. */
const CHAIN_TIMEOUT_MS = 1_500;

/**
 * Set in the chained command's environment, and checked on the way in.
 *
 * The string guard below is necessary and not sufficient. It can only see what is written in
 * the command, and a wrapper is free to invoke us from somewhere it cannot: a launcher that
 * reads the program it wraps from its OWN config file names us nowhere in the string. Nor does
 * the string have to say "obrigado" — a checkout in a directory called anything else, or a
 * shell alias, defeats it. This variable does not care: it rides the process tree, so it is
 * true exactly when we are already running inside our own chain, whatever the route.
 *
 * Two failures are prevented, and the second is the expensive one. Without it a mutual chain
 * forks once per render forever; and each nested render would rotate a creative and report an
 * impression, billing an advertiser several times for one line the developer saw once.
 */
export const CHAIN_MARKER = "OBRIGADO_CHAINING";

/**
 * Whether this process is a nested render, spawned by our own chain.
 *
 * The correct behaviour when true is to print nothing at all rather than to print an unchained
 * line: the outer process is already going to print ours, and a second copy is both a duplicate
 * row and a second impression.
 */
export function isChainedRender(env: Record<string, string | undefined> = process.env): boolean {
  return env[CHAIN_MARKER] === "1";
}

/**
 * Run the chained command, feeding it the same stdin payload Claude Code sent.
 *
 * Returns its stdout, or null on any failure. Failure is silent by design: a
 * broken chained command should cost the developer their own line, not fill
 * their terminal with our error output.
 */
export async function runChained(command: string, stdinPayload: string): Promise<string | null> {
  // Last line of defence against self-invocation. If a bad config ever names
  // our own command, spawning it would fork once per render, forever.
  if (/obrigado/iu.test(command) && /statusline/u.test(command)) return null;

  try {
    const proc = Bun.spawn(["sh", "-c", command], {
      stdin: new TextEncoder().encode(stdinPayload),
      stdout: "pipe",
      stderr: "ignore",
      // A separate process group lets timeout tear down the user's complete
      // command tree. Killing only the shell leaves descendants holding stdout
      // open on Linux, so the read still hangs even after the shell exits.
      detached: true,
      // Inherit the environment so their command sees the same terminal it
      // would have seen if Claude Code had invoked it directly — plus the marker,
      // so a route back to us through their command terminates.
      env: { ...process.env, [CHAIN_MARKER]: "1" },
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }, CHAIN_TIMEOUT_MS);
    const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timeout);

    if (timedOut || exitCode !== 0) return null;
    const trimmed = output.replace(/\n+$/u, "");
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Read the JSON payload Claude Code pipes in.
 *
 * Guarded against a TTY: reading stdin interactively would hang the status line
 * forever, and `obrigado statusline` is also runnable by hand for debugging.
 */
export async function readStdinPayload(): Promise<string> {
  if (process.stdin.isTTY === true) return "";
  try {
    return await Bun.stdin.text();
  } catch {
    return "";
  }
}
