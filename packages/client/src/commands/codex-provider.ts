/**
 * `obrigado codex-provider`: the process Codex starts and reads its footer from.
 *
 * What it says to Codex is `codex-provider.ts`; this is the process around that. It reads
 * requests from stdin a line at a time, answers each on stdout, and ends when Codex closes the
 * pipe. Three things are kept between reads, per thread: what the thread was last doing, the line
 * the renderer last gave for it, and whether the renderer is running for it now.
 *
 * A read never waits on the renderer. It draws the developer's footer from the state Codex just
 * sent, adds whatever line is already in hand, and answers. Where something happened in the
 * session (`observe`), the renderer is started beside the read, and its line is there for the
 * next one a second later.
 *
 * The line comes from `obrigado statusline --agent codex --json`, the one renderer every host
 * drives (INVARIANT 13), run as its own process. It could be called in this one, and is not, for
 * the reason the Pi extension and the OpenCode plugin do not either: the renderer writes its line
 * to stdout, which here is the wire to Codex, and it ends by shipping beacons, which a footer
 * should not wait for.
 *
 * Nothing here may write to stdout but a reply, and nothing may throw: either one ends the footer
 * for the session (`codex-provider.ts`). Every failure is the developer's own footer, drawn as it
 * would have been without us.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import { ChainedProvider, stdioServerFrom } from "../codex-chain.ts";
import { redrawFooter } from "../codex-footer.ts";
import type { FooterMachine } from "../codex-footer.ts";
import { observe, rendererPayload, replyTo, threadFacts } from "../codex-provider.ts";
import type { ThreadFacts, ThreadMemory } from "../codex-provider.ts";
import { CODEX_CONFIG_PATH } from "../codex-statusline.ts";
import { footerTree, lineNode, parseRenderedLine, validTree } from "../codex-tree.ts";
import type { RenderedLine, UiNode } from "../codex-tree.ts";
import { codexIntegration, readConfig } from "../config.ts";
import { parseToml } from "../toml-edit.ts";

/** A renderer that has printed nothing by now is not going to in time to matter. */
const RENDER_TIMEOUT_MS = 4000;

/** A thread not read for this long has been closed, and its memory is let go. */
const FORGET_AFTER_MS = 60 * 60 * 1000;

/** What the renderer gave: a line, nothing to show, or no answer at all. */
type Rendered =
  | { readonly kind: "line"; readonly line: RenderedLine }
  | { readonly kind: "none" }
  | { readonly kind: "failed" };

/** Whether this module was loaded from a compiled binary, where the CLI is the program itself. */
function isCompiledBinary(path = import.meta.path): boolean {
  return path.includes("$bunfs") || path.includes("~BUN");
}

/**
 * The renderer as an argv: this same program, asked for `statusline`.
 *
 * Itself rather than whatever `obrigado` is on PATH, so the provider and the renderer are always
 * the one version. `OBRIGADO_STATUSLINE_COMMAND` replaces it, as it does for every host that
 * starts the renderer, for running against a checkout and for tests; it is split on spaces here,
 * which is all either needs. Codex passes a server it starts only a short list of
 * variables, so to reach this one the override goes in `[mcp_servers.obrigado.env]`.
 */
function rendererArgv(env: Readonly<Record<string, string | undefined>>): string[] {
  const override = env["OBRIGADO_STATUSLINE_COMMAND"]?.trim() ?? "";
  const base =
    override.length > 0
      ? override.split(/\s+/u)
      : isCompiledBinary()
        ? [process.execPath, "statusline"]
        : [process.execPath, join(dirname(import.meta.path), "..", "cli.ts"), "statusline"];
  return [...base, "--agent", "codex", "--json"];
}

/** Run the renderer once for a thread. The first whole line it prints is the answer. */
async function render(payload: string): Promise<Rendered> {
  const [command, ...args] = rendererArgv(process.env);
  if (command === undefined) return { kind: "failed" };
  const { spawn } = await import("node:child_process");
  return await new Promise<Rendered>((resolve) => {
    let settled = false;
    let out = "";
    const finish = (value: Rendered): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // oxlint-disable-next-line promise/no-multiple-resolved -- `settled` above is the guard
      resolve(value);
    };
    const firstLine = (): string | undefined =>
      out.split("\n").find((value) => value.trim().length > 0);

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "ignore"],
      // No console window for the renderer on Windows, where one would flash per render (A46).
      windowsHide: true,
    });
    // Fires only when no line has come. A renderer that answered is still shipping the impression
    // it just drew, and is left to finish.
    const timer = setTimeout(() => {
      child.kill();
      finish({ kind: "failed" });
    }, RENDER_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (!out.includes("\n")) return;
      const line = firstLine();
      if (line === undefined) return;
      const parsed = parseRenderedLine(line);
      finish(parsed === null ? { kind: "failed" } : { kind: "line", line: parsed });
    });
    child.on("error", () => {
      finish({ kind: "failed" });
    });
    child.on("close", (code) => {
      const line = firstLine();
      if (line === undefined) {
        // Ran and printed nothing: no batch, a CI machine, an install that was removed. That is
        // an answer, and it clears the line. Anything else leaves the last one where it is.
        finish(code === 0 ? { kind: "none" } : { kind: "failed" });
        return;
      }
      const parsed = parseRenderedLine(line);
      finish(parsed === null ? { kind: "failed" } : { kind: "line", line: parsed });
    });
    child.stdin.on("error", () => {
      finish({ kind: "failed" });
    });
    child.stdin.end(payload);
  });
}

/** This machine, for the parts of Codex's footer its state does not carry. */
function footerMachine(): FooterMachine {
  return {
    home: homedir(),
    hostname: hostname(),
    platform: process.platform,
    now: Date.now(),
    exists: (path) => existsSync(path),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

interface Thread {
  memory: ThreadMemory;
  line: RenderedLine | null;
  rendering: boolean;
  seenAt: number;
}

/** What `config.toml` and our own config say once, when the provider starts. */
interface Setup {
  /** Whether Codex colours its footer's items. On unless `tui.status_line_use_colors` is false. */
  readonly useColors: boolean;
  readonly chained: ChainedProvider | null;
}

/**
 * Codex's config, from where install said it is.
 *
 * `--codex-home` is written by install where `CODEX_HOME` was set, because Codex does not pass
 * that variable on to a server it starts (`codexProviderArgv`).
 */
function codexConfig(argv: readonly string[]): Record<string, unknown> | null {
  const home = argv[argv.indexOf("--codex-home") + 1];
  const path =
    argv.includes("--codex-home") && home !== undefined
      ? join(home, "config.toml")
      : CODEX_CONFIG_PATH;
  try {
    return parseToml(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function setup(argv: readonly string[]): Promise<Setup> {
  const codex = codexConfig(argv);
  const tui = codex?.["tui"];
  const useColors =
    typeof tui !== "object" ||
    tui === null ||
    (tui as Record<string, unknown>)["status_line_use_colors"] !== false;

  const ours = await readConfig().catch(() => null);
  const provider = codexIntegration(ours)?.chained_provider;
  const server = provider === undefined ? null : stdioServerFrom(codex, provider.server);
  return {
    useColors,
    chained:
      provider === undefined || server === null ? null : new ChainedProvider(server, provider.tool),
  };
}

/** The footer for each read, and what is kept between them. */
class Footer {
  readonly #setup: Setup;
  readonly #threads = new Map<string, Thread>();

  constructor(given: Setup) {
    this.#setup = given;
  }

  /** Ask the renderer for a thread's line, one request at a time. */
  async #refresh(facts: ThreadFacts, thread: Thread): Promise<void> {
    // Two at once would each advance the rotation, spending an impression nobody saw.
    if (thread.rendering) return;
    thread.rendering = true;
    try {
      const rendered = await render(rendererPayload(facts, thread.memory.prompt));
      if (rendered.kind === "line") thread.line = rendered.line;
      else if (rendered.kind === "none") thread.line = null;
    } catch {
      // The line in hand stays where it is.
    } finally {
      thread.rendering = false;
    }
  }

  /** The line for the thread a read is about, after noting what the read says happened. */
  #lineFor(state: unknown, now: number): RenderedLine | null {
    const facts = threadFacts(state);
    if (facts === null) return null;
    const known = this.#threads.get(facts.id);
    const { memory, ask } = observe(known?.memory, facts, now);
    const thread: Thread = known ?? { memory, line: null, rendering: false, seenAt: now };
    thread.memory = memory;
    thread.seenAt = now;
    this.#threads.set(facts.id, thread);
    // Not waited for: the line it brings is for the next read, a second from now.
    if (ask) void this.#refresh(facts, thread);
    for (const [id, other] of this.#threads) {
      if (now - other.seenAt > FORGET_AFTER_MS) this.#threads.delete(id);
    }
    return thread.line;
  }

  /** The developer's footer: their own provider's where one is chained and answers, else Codex's. */
  async #theirs(state: unknown): Promise<UiNode | null> {
    try {
      const chained = await this.#setup.chained?.read(state);
      if (chained !== undefined) return chained;
      const drawn = redrawFooter(state, footerMachine(), { useColors: this.#setup.useColors });
      return validTree(drawn) ? drawn : null;
    } catch {
      return null;
    }
  }

  /** One read's answer, as the JSON Codex parses. Never a throw: `null` is an empty footer. */
  async read(state: unknown): Promise<string> {
    try {
      const line = this.#lineFor(state, Date.now());
      const theirs = await this.#theirs(state);
      return JSON.stringify(footerTree(theirs, line === null ? null : lineNode(line)));
    } catch {
      return "null";
    }
  }

  async close(): Promise<void> {
    await this.#setup.chained?.close();
  }
}

/** Answer one line from Codex, where an answer is owed. */
async function answer(line: string, footer: Footer): Promise<void> {
  if (line.trim().length === 0) return;
  try {
    const reply = await replyTo(line, (state) => footer.read(state));
    if (reply !== null) process.stdout.write(`${reply}\n`);
  } catch {
    // `replyTo` answers its own failures. Nothing reaches here that a reply could say.
  }
}

export async function codexProvider(argv: readonly string[] = []): Promise<number> {
  const footer = new Footer(await setup(argv));
  let buffer = "";

  process.stdin.setEncoding("utf8");
  await new Promise<void>((resolve) => {
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        // Not waited for, so a read that is waiting on a chained provider does not hold a ping.
        void answer(buffer.slice(0, newline), footer);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
    process.stdin.on("error", resolve);
  });
  await footer.close();
  return 0;
}
