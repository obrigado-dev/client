/**
 * The one module both OpenCode majors load (`src/tui.tsx`): each finds its own entry point in the
 * default export, claims its slot, tells the renderer which session is open and when the person
 * last typed in it, and lets go when it is torn down.
 *
 * The renderer is replaced through `OBRIGADO_STATUSLINE_COMMAND` with a command that only records
 * the payload it is handed, so nothing here draws and nothing leaves the machine.
 */
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui";

import type { OpenCode2Context } from "../src/opencode2.ts";
import plugin from "../src/tui.tsx";

/** OpenCode 1's check of a TUI module (1.18.10 through 1.19.0: `readV1Plugin`, then the id). */
function openCode1Accepts(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { id, server, tui } = value as Record<string, unknown>;
  if (server !== undefined && typeof server !== "function") return false;
  if (tui !== undefined && typeof tui !== "function") return false;
  if (server !== undefined && tui !== undefined) return false;
  if (tui === undefined) return false;
  return id === undefined || (typeof id === "string" && id.trim().length > 0);
}

/** OpenCode 2's (2.0.29: `isPlugin`), which answered 0.3.0 with "Invalid V2 TUI plugin module". */
function openCode2Accepts(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { id, setup } = value as Record<string, unknown>;
  return typeof id === "string" && id.length > 0 && typeof setup === "function";
}

let payloadFile = "";
let teardowns: Array<() => unknown> = [];
const configured = process.env["OBRIGADO_STATUSLINE_COMMAND"];

beforeEach(async () => {
  payloadFile = join(await mkdtemp(join(tmpdir(), "obrigado-opencode-plugin-")), "payload.json");
  process.env["OBRIGADO_STATUSLINE_COMMAND"] = `sh -c 'cat > "${payloadFile}"'`;
});

afterEach(async () => {
  // Every line started here stops here, so no timer outlives its test.
  await Promise.all(teardowns.splice(0).map((teardown) => teardown()));
  if (configured === undefined) delete process.env["OBRIGADO_STATUSLINE_COMMAND"];
  else process.env["OBRIGADO_STATUSLINE_COMMAND"] = configured;
});

/** What the plugin handed the renderer on its first fetch. */
async function payloadSent(): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling for a child process's write
    const text = await readFile(payloadFile, "utf8").catch(() => "");
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // oxlint-disable-next-line eslint/no-await-in-loop -- polling for a child process's write
      await Bun.sleep(20);
    }
  }
  throw new Error("the plugin never ran the renderer");
}

async function rendererRan(): Promise<boolean> {
  await Bun.sleep(300);
  return stat(payloadFile).then(
    () => true,
    () => false,
  );
}

type Claim = { readonly append?: unknown; readonly render?: unknown };

function openCode2(
  route: { type: string; sessionID?: string },
  slot: (claim: Claim) => () => void,
): OpenCode2Context {
  return {
    ui: { router: { current: () => route }, slot },
    data: {
      session: {
        message: {
          list: () => [
            { id: "msg_1", type: "user", time: { created: 1_000 } },
            { id: "msg_2", type: "synthetic", time: { created: 2_000 } },
          ],
        },
      },
    },
  } as unknown as OpenCode2Context;
}

describe("one module for both majors", () => {
  test("OpenCode 1 finds `tui()` in it and OpenCode 2 finds `id` and `setup()`", () => {
    expect(openCode1Accepts(plugin)).toBe(true);
    expect(openCode2Accepts(plugin)).toBe(true);
    // 0.3.0's shape, which OpenCode 2 refused to load.
    expect(openCode2Accepts({ id: "obrigado", tui: plugin.tui })).toBe(false);
  });
});

describe("OpenCode 2", () => {
  test("appends to `app`, names the open session and the person's last message, and lets go", async () => {
    const claims: Claim[] = [];
    let released = 0;
    const teardown = plugin.setup(
      openCode2({ type: "session", sessionID: "ses_1" }, (claim) => {
        claims.push(claim);
        return () => {
          released += 1;
        };
      }),
    );
    teardowns.push(teardown);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.append).toBe("app");
    expect(typeof claims[0]?.render).toBe("function");
    expect(await payloadSent()).toMatchObject({
      session_id: "ses_1",
      prompt_id: "msg_1",
      prompt_at: 1_000,
    });

    teardown();
    expect(released).toBe(1);
  });

  test("on the home route, is the home rotation and claims no prompt", async () => {
    teardowns.push(plugin.setup(openCode2({ type: "home" }, () => () => {})));
    const payload = await payloadSent();
    expect(payload["session_id"]).toBe("opencode-home");
    expect(payload).not.toHaveProperty("prompt_id");
  });

  test("a refused claim fails the load, and the renderer is never asked for a line", async () => {
    const context = openCode2({ type: "home" }, () => {
      throw new Error("no such slot");
    });
    expect(() => plugin.setup(context)).toThrow("no such slot");
    // A line that ran behind a slot the host refused would bill for copy nobody can see.
    expect(await rendererRan()).toBe(false);
  });
});

describe("OpenCode 1", () => {
  test("registers `app_bottom` late, names the open session, and stops when disposed", async () => {
    const registered: Array<{ order?: number; slots: Record<string, unknown> }> = [];
    const disposers: Array<() => unknown> = [];
    const api = {
      route: { current: { name: "session", params: { sessionID: "ses_2" } } },
      state: {
        session: { messages: () => [{ id: "msg_3", role: "user", time: { created: 3_000 } }] },
        part: () => [{ type: "text", text: "fix the build" }],
      },
      slots: {
        register: (entry: (typeof registered)[number]) => {
          registered.push(entry);
          return "obrigado";
        },
      },
      lifecycle: {
        onDispose: (dispose: () => unknown) => {
          disposers.push(dispose);
          return () => {};
        },
      },
    } as unknown as TuiPluginApi;

    await plugin.tui(api, undefined, {} as TuiPluginMeta);
    teardowns.push(...disposers);

    expect(registered).toHaveLength(1);
    expect(registered[0]?.order).toBe(90);
    expect(Object.keys(registered[0]?.slots ?? {})).toEqual(["app_bottom"]);
    expect(disposers).toHaveLength(1);
    expect(await payloadSent()).toMatchObject({
      session_id: "ses_2",
      prompt_id: "msg_3",
      prompt_at: 3_000,
    });
  });
});
