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
      // would have seen if Claude Code had invoked it directly.
      env: process.env,
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
