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
import { existsSync } from "node:fs";
import { win32 } from "node:path";

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

/** The machine the chain runs on, passed in so a test can stand up Windows anywhere. */
export interface ChainMachine {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly which: (program: string) => string | null;
  readonly exists: (path: string) => boolean;
}

function thisMachine(): ChainMachine {
  return {
    platform: process.platform,
    env: process.env,
    which: (program) => Bun.which(program),
    exists: existsSync,
  };
}

/**
 * Git Bash, where Claude Code looks for it on Windows: `CLAUDE_CODE_GIT_BASH_PATH`, then Git's
 * install folders, then the `bin` folder of the Git whose `git` is on PATH. Windows paths
 * whatever this runs on, so a test on another system reads them the same way.
 */
function gitBash(machine: ChainMachine): string | null {
  const configured = machine.env["CLAUDE_CODE_GIT_BASH_PATH"];
  const git = machine.which("git");
  const candidates = [
    ...(configured === undefined || configured === "" ? [] : [configured]),
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    // `git` is `Git\cmd\git.exe` as Git's installer puts it on PATH, `Git\mingw64\bin\git.exe`
    // as some put it there by hand.
    ...(git === null
      ? []
      : [
          win32.resolve(git, "..", "..", "bin", "bash.exe"),
          win32.resolve(git, "..", "..", "..", "bin", "bash.exe"),
        ]),
  ];
  return candidates.find((path) => machine.exists(path)) ?? null;
}

/**
 * The argv that runs `command` in the shell Claude Code runs a status line in (A46).
 *
 * The chained command is the developer's own status line, written for that shell, so it runs in
 * the same one. `sh` everywhere but Windows. There Claude Code uses Git Bash when it finds one,
 * and PowerShell, with the same flags, when it does not.
 */
export function chainArgv(command: string, machine: ChainMachine = thisMachine()): string[] {
  if (machine.platform !== "win32") return ["sh", "-c", command];
  const bash = gitBash(machine);
  if (bash !== null) return [bash, "-c", command];
  const powershell =
    machine.which("pwsh") ??
    machine.which("powershell") ??
    win32.join(
      machine.env["SystemRoot"] ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  return [
    powershell,
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ];
}

/**
 * End `proc` and everything it started.
 *
 * Killing only the shell leaves its children holding stdout open, so reading the chained line
 * would still hang. Elsewhere the command has a process group of its own to kill. Windows has
 * none, and `taskkill /T` walks the tree instead.
 */
function killTree(proc: {
  readonly pid: number;
  kill(signal?: number | NodeJS.Signals): void;
}): void {
  if (process.platform === "win32") {
    try {
      const killer = Bun.spawn(["taskkill", "/pid", String(proc.pid), "/T", "/F"], {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      // The shell itself, whatever taskkill managed: after it, so the tree is walked first.
      void killer.exited.then(() => proc.kill());
    } catch {
      proc.kill();
    }
    return;
  }
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
}

/** All of `reader`'s text, to the end of the stream. */
async function readText(reader: {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
}): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read one chunk after another
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
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
    const proc = Bun.spawn(chainArgv(command), {
      stdin: new TextEncoder().encode(stdinPayload),
      stdout: "pipe",
      stderr: "ignore",
      // A separate process group lets timeout tear down the user's complete
      // command tree. Killing only the shell leaves descendants holding stdout
      // open on Linux, so the read still hangs even after the shell exits.
      // Windows has no process groups, and `detached` there would start the
      // shell without a console, so each program it runs opened a window.
      detached: process.platform !== "win32",
      windowsHide: true,
      // Inherit the environment so their command sees the same terminal it
      // would have seen if Claude Code had invoked it directly — plus the marker,
      // so a route back to us through their command terminates.
      env: { ...process.env, [CHAIN_MARKER]: "1" },
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        killTree(proc);
        resolve(null);
      }, CHAIN_TIMEOUT_MS);
    });
    const reader = proc.stdout.getReader();
    const finished = Promise.all([readText(reader), proc.exited]);
    finished.catch(() => {});
    const result = await Promise.race([finished, timedOut]);
    clearTimeout(timer);

    if (result === null) {
      // Without waiting for their output to close. Something the command started can hold it
      // open past the kill: on Windows `taskkill` was seen to leave a Git Bash `sleep` holding it
      // for the whole of its 30 seconds (A46). The line goes on without theirs.
      await reader.cancel().catch(() => {});
      return null;
    }
    const [output, exitCode] = result;
    if (exitCode !== 0) return null;
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
