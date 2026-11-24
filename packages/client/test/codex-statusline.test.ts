import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UNREDRAWABLE_ITEMS } from "../src/codex-footer.ts";
import { codexConfigBlock, planCodexInstall, planCodexUninstall } from "../src/codex-plan.ts";
import type { CodexPlan } from "../src/codex-plan.ts";
import {
  codexConfigured,
  codexProviderArgv,
  installCodexStatusLine,
  supportsProvider,
  uninstallCodexStatusLine,
} from "../src/codex-statusline.ts";
import { refusalRow } from "../src/commands/install-codex.ts";
import { agentFromArgv } from "../src/commands/statusline.ts";
import type { CodexIntegrationConfig } from "../src/config.ts";
import { parseToml } from "../src/toml-edit.ts";

const ARGV = ["/Users/dev/.local/bin/obrigado", "codex-provider"];
const OURS = { server: "obrigado", tool: "statusline" };
const SERVER = { command: "/Users/dev/.local/bin/obrigado", args: ["codex-provider"] };

/** A config a developer keeps by hand, with Codex's own footer and nothing of ours. */
const PLAIN = `# my codex
model = "gpt-6.1"

[tui]
# what I like to see
status_line = ["model-with-reasoning", "context-remaining", "current-dir"]
theme = "catppuccin"

[mcp_servers.docs]
command = "docs-mcp"
`;

/** One with another provider already in the footer's slot. */
const WITH_PROVIDER = `[features]
tui_extensions_statusline = true

[tui]
status_line_provider = { server = "usage", tool = "footer" }

[mcp_servers.usage]
command = "ccusage"
args = ["codex", "statusline"]
`;

function planned(plan: CodexPlan): Extract<CodexPlan, { status: "planned" }> {
  if (plan.status !== "planned") throw new Error(`refused: ${JSON.stringify(plan.refusal)}`);
  return plan;
}

function refusal(plan: CodexPlan): Extract<CodexPlan, { status: "refused" }>["refusal"] {
  if (plan.status !== "refused") throw new Error("expected a refusal");
  return plan.refusal;
}

function record(plan: CodexPlan): CodexIntegrationConfig {
  return { installed: true, ...planned(plan).record };
}

describe("which Codex has a status line provider", () => {
  test("0.171.0 and everything after it, pre-releases included", () => {
    expect(supportsProvider("0.171.0")).toBe(true);
    expect(supportsProvider("0.171.1")).toBe(true);
    expect(supportsProvider("0.173.0")).toBe(true);
    expect(supportsProvider("1.0.0")).toBe(true);
  });

  test("nothing before it", () => {
    expect(supportsProvider("0.170.9")).toBe(false);
    expect(supportsProvider("0.169.0")).toBe(false);
    expect(supportsProvider("0.39.0")).toBe(false);
  });
});

describe("installing into a config with Codex's own footer", () => {
  const plan = planned(planCodexInstall(PLAIN, { argv: ARGV }));

  test("adds the switch, the selection and our server, and changes nothing else", () => {
    expect(parseToml(plan.next)).toEqual({
      model: "gpt-6.1",
      tui: {
        status_line: ["model-with-reasoning", "context-remaining", "current-dir"],
        theme: "catppuccin",
        status_line_provider: OURS,
      },
      mcp_servers: { docs: { command: "docs-mcp" }, obrigado: SERVER },
      features: { tui_extensions_statusline: true },
    });
  });

  test("keeps the developer's comments and order: only lines are added", () => {
    const kept = PLAIN.split("\n").filter((line) => line.length > 0);
    const after = plan.next.split("\n");
    let from = 0;
    for (const line of kept) {
      const at = after.indexOf(line, from);
      expect(at).toBeGreaterThanOrEqual(from);
      from = at + 1;
    }
  });

  test("records what to put back: no provider, and a switch that was not set", () => {
    expect(plan.record).toEqual({
      previous_provider: null,
      chained_provider: undefined,
      previous_feature: null,
    });
    expect(plan.dropped).toEqual([]);
  });

  test("a second install finds nothing to do, and keeps the first record", () => {
    const again = planned(
      planCodexInstall(plan.next, { argv: ARGV, record: { installed: true, ...plan.record } }),
    );
    expect(again.next).toBe(plan.next);
    expect(again.record).toEqual(plan.record);
  });

  test("a binary that moved is the one thing a reinstall rewrites", () => {
    const moved = planned(
      planCodexInstall(plan.next, {
        argv: ["/opt/obrigado", "codex-provider"],
        record: { installed: true, ...plan.record },
      }),
    );
    expect(parseToml(moved.next)?.["mcp_servers"]).toEqual({
      docs: { command: "docs-mcp" },
      obrigado: { command: "/opt/obrigado", args: ["codex-provider"] },
    });
    expect(moved.record).toEqual(plan.record);
  });

  test("uninstall gives the file back byte for byte", () => {
    const removal = planCodexUninstall(plan.next, { installed: true, ...plan.record });
    expect(removal.outcome).toBe("removed");
    expect(removal.next).toBe(PLAIN);
  });

  test("an empty or missing config is installed into, and emptied again", () => {
    const fresh = planned(planCodexInstall("", { argv: ARGV }));
    expect(parseToml(fresh.next)).toEqual({
      features: { tui_extensions_statusline: true },
      tui: { status_line_provider: OURS },
      mcp_servers: { obrigado: SERVER },
    });
    expect(planCodexUninstall(fresh.next, { installed: true, ...fresh.record }).next).toBe("");
  });
});

describe("the experimental switch", () => {
  test("one the developer turned off is turned on, and off again by uninstall", () => {
    const text = "[features]\ntui_extensions_statusline = false\nshell_tool = true\n";
    const plan = planCodexInstall(text, { argv: ARGV });
    expect(planned(plan).record.previous_feature).toBe(false);
    expect(parseToml(planned(plan).next)?.["features"]).toEqual({
      tui_extensions_statusline: true,
      shell_tool: true,
    });
    expect(planCodexUninstall(planned(plan).next, record(plan)).next).toBe(text);
  });

  test("one that was already on is not ours to turn off", () => {
    const text = "[features]\ntui_extensions_statusline = true\n";
    const plan = planCodexInstall(text, { argv: ARGV });
    expect("previous_feature" in planned(plan).record).toBe(false);
    expect(planCodexUninstall(planned(plan).next, record(plan)).next).toBe(text);
  });
});

describe("a footer a provider could not keep", () => {
  const lost = UNREDRAWABLE_ITEMS[0] ?? "pull-request-number";
  const text = `[tui]\nstatus_line = ["model-with-reasoning", "${lost}", "current-dir"]\n`;

  test("there is at least one item Codex does not tell a provider", () => {
    expect(UNREDRAWABLE_ITEMS.length).toBeGreaterThan(0);
  });

  test("is refused, naming what would go", () => {
    expect(refusal(planCodexInstall(text, { argv: ARGV }))).toEqual({
      kind: "items",
      items: [lost],
    });
  });

  test("is taken with --replace, which says what it gave up", () => {
    const plan = planned(planCodexInstall(text, { argv: ARGV, replace: true }));
    expect(plan.dropped).toEqual([lost]);
    expect(parseToml(plan.next)?.["tui"]).toEqual({
      status_line: ["model-with-reasoning", lost, "current-dir"],
      status_line_provider: OURS,
    });
  });

  test("does not come up again on a reinstall the developer already agreed to", () => {
    const first = planned(planCodexInstall(text, { argv: ARGV, replace: true }));
    const again = planCodexInstall(first.next, { argv: ARGV, record: record(first) });
    expect(planned(again).next).toBe(first.next);
  });
});

describe("another provider in the slot", () => {
  const theirs = { server: "usage", tool: "footer" };

  test("is left there, and install says whether --chain could keep it", () => {
    expect(refusal(planCodexInstall(WITH_PROVIDER, { argv: ARGV }))).toEqual({
      kind: "provider",
      provider: theirs,
      chainable: true,
    });
  });

  test("--chain takes the slot and records theirs to run and to put back", () => {
    const plan = planned(planCodexInstall(WITH_PROVIDER, { argv: ARGV, chain: true }));
    expect(parseToml(plan.next)).toEqual({
      features: { tui_extensions_statusline: true },
      tui: { status_line_provider: OURS },
      mcp_servers: {
        usage: { command: "ccusage", args: ["codex", "statusline"] },
        obrigado: SERVER,
      },
    });
    expect(plan.record).toEqual({ previous_provider: theirs, chained_provider: theirs });
  });

  test("chained, their footer is theirs to draw, so an item of Codex's own is not at stake", () => {
    const lost = UNREDRAWABLE_ITEMS[0] ?? "pull-request-number";
    const text = WITH_PROVIDER.replace("[tui]\n", `[tui]\nstatus_line = ["${lost}"]\n`);
    expect(planned(planCodexInstall(text, { argv: ARGV, chain: true })).dropped).toEqual([]);
  });

  test("--replace takes the slot without running theirs", () => {
    const plan = planned(planCodexInstall(WITH_PROVIDER, { argv: ARGV, replace: true }));
    expect(plan.record).toEqual({ previous_provider: theirs, chained_provider: undefined });
  });

  test("uninstall hands the slot back, and leaves on the switch their provider needs", () => {
    for (const options of [{ chain: true }, { replace: true }]) {
      const plan = planCodexInstall(WITH_PROVIDER, { argv: ARGV, ...options });
      const removal = planCodexUninstall(planned(plan).next, record(plan));
      expect(removal.outcome).toBe("removed");
      expect(removal.next).toBe(WITH_PROVIDER);
    }
  });

  test("a reinstall keeps the chain it was installed with", () => {
    const first = planCodexInstall(WITH_PROVIDER, { argv: ARGV, chain: true });
    const again = planned(
      planCodexInstall(planned(first).next, { argv: ARGV, record: record(first) }),
    );
    expect(again.record.chained_provider).toEqual(theirs);
    expect(again.record.previous_provider).toEqual(theirs);
  });

  test("a chain whose server has since gone from the file is dropped, not started", () => {
    const first = planCodexInstall(WITH_PROVIDER, { argv: ARGV, chain: true });
    const without = planned(first).next.replace(
      '[mcp_servers.usage]\ncommand = "ccusage"\nargs = ["codex", "statusline"]\n',
      "",
    );
    const again = planned(planCodexInstall(without, { argv: ARGV, record: record(first) }));
    expect(again.record.chained_provider).toBeUndefined();
  });

  test("one that is not a command in this file cannot be chained, and --chain says so", () => {
    const remote = WITH_PROVIDER.replace(
      'command = "ccusage"\nargs = ["codex", "statusline"]',
      'url = "https://example.com/mcp"',
    );
    const expected = { kind: "provider", provider: theirs, chainable: false } as const;
    expect(refusal(planCodexInstall(remote, { argv: ARGV }))).toEqual(expected);
    expect(refusal(planCodexInstall(remote, { argv: ARGV, chain: true }))).toEqual(expected);
    expect(planCodexInstall(remote, { argv: ARGV, replace: true }).status).toBe("planned");
  });

  test("the built-in footer picked by name is put back by name", () => {
    const text = '[tui]\nstatus_line_provider = "default"\n';
    const plan = planCodexInstall(text, { argv: ARGV });
    expect(planned(plan).record.previous_provider).toBe("default");
    expect(planCodexUninstall(planned(plan).next, record(plan)).next).toBe(text);
  });
});

describe("uninstalling", () => {
  test("where the developer has since picked another provider, theirs and its switch stay", () => {
    const plan = planCodexInstall(PLAIN, { argv: ARGV });
    const switched = planned(plan).next.replace(
      'status_line_provider = { server = "obrigado", tool = "statusline" }',
      'status_line_provider = { server = "usage", tool = "footer" }',
    );
    const removal = planCodexUninstall(switched, record(plan));
    expect(removal.outcome).toBe("foreign");
    const after = parseToml(removal.next);
    expect(after?.["tui"]).toMatchObject({
      status_line_provider: { server: "usage", tool: "footer" },
    });
    expect(after?.["features"]).toEqual({ tui_extensions_statusline: true });
    expect(after?.["mcp_servers"]).toEqual({ docs: { command: "docs-mcp" } });
  });

  test("with nothing of ours in the file there is nothing to do", () => {
    expect(planCodexUninstall(PLAIN, null)).toEqual({ next: PLAIN, outcome: "not-installed" });
    expect(planCodexUninstall("", null)).toEqual({ next: "", outcome: "not-installed" });
  });

  test("without a record, ours still goes and the switch is left as found", () => {
    const plan = planned(planCodexInstall(PLAIN, { argv: ARGV }));
    const removal = planCodexUninstall(plan.next, null);
    expect(removal.outcome).toBe("removed");
    expect(parseToml(removal.next)).toEqual({
      ...parseToml(PLAIN),
      features: { tui_extensions_statusline: true },
    });
  });
});

describe("a file this cannot edit safely is left alone", () => {
  test("one that is not TOML", () => {
    expect(refusal(planCodexInstall("[tui\nbroken", { argv: ARGV }))).toEqual({
      kind: "unreadable",
    });
    expect(planCodexUninstall("[tui\nbroken", null).outcome).toBe("unreadable");
  });

  test("one that sets tui as dotted keys, where a [tui] table would define it twice", () => {
    expect(refusal(planCodexInstall('tui.theme = "x"\n', { argv: ARGV })).kind).toBe("uneditable");
  });

  test("one whose provider is set over several lines", () => {
    const text = '[tui]\nstatus_line_provider = {\n  server = "x", tool = "y" }\n';
    // Not TOML 1.0 at all, so it is refused before it is edited.
    expect(planCodexInstall(text, { argv: ARGV }).status).toBe("refused");
  });

  test("the refusal prints the three settings to add by hand", () => {
    const { row, failed } = refusalRow({ kind: "uneditable", why: "because" }, false);
    expect(failed).toBe(true);
    const notes = (row.notes ?? []).join("\n");
    expect(notes).toContain("tui_extensions_statusline = true");
    expect(notes).toContain('status_line_provider = { server = "obrigado", tool = "statusline" }');
    expect(notes).toContain("[mcp_servers.obrigado]");
  });
});

describe("what a refusal costs the run", () => {
  test("an old Codex is a skipped line for a bare install, and a failure when asked for by name", () => {
    const bare = refusalRow({ kind: "too-old", version: "0.169.0" }, false);
    expect(bare.failed).toBe(false);
    expect(bare.row.mark).toBe("skipped");
    expect(bare.row.detail).toContain("0.171.0");
    expect(bare.row.detail).toContain("0.169.0");

    const named = refusalRow({ kind: "too-old", version: "0.169.0" }, true);
    expect(named.failed).toBe(true);
    expect((named.row.notes ?? []).join("\n")).toContain("codex update");
  });

  test("something of the developer's in the way fails either way, with the way through", () => {
    const provider = refusalRow(
      { kind: "provider", provider: { server: "usage", tool: "footer" }, chainable: true },
      false,
    );
    expect(provider.failed).toBe(true);
    expect((provider.row.notes ?? []).join("\n")).toContain("--chain");

    const items = refusalRow({ kind: "items", items: ["pull-request-number"] }, false);
    expect(items.failed).toBe(true);
    expect(items.row.detail).toContain("pull-request-number");
    expect((items.row.notes ?? []).join("\n")).toContain("--replace");
  });
});

describe("the write", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "obrigado-codex-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const machine = (): { path: string; backupDir: string; binary: null; argv: string[] } => ({
    path: join(dir, "config.toml"),
    backupDir: join(dir, "backups"),
    // No `codex` to check the result with: the plan's own check is what is under test.
    binary: null,
    argv: ARGV,
  });

  test("is refused for a Codex with no provider, before the file is opened", async () => {
    await Bun.write(join(dir, "config.toml"), PLAIN);
    const outcome = await installCodexStatusLine({ ...machine(), version: "0.169.0" });
    expect(outcome).toEqual({
      status: "refused",
      refusal: { kind: "too-old", version: "0.169.0" },
    });
    expect(await Bun.file(join(dir, "config.toml")).text()).toBe(PLAIN);
  });

  test("is refused where there is no codex to ask its version", async () => {
    expect(await installCodexStatusLine({ ...machine(), version: null })).toEqual({
      status: "refused",
      refusal: { kind: "no-binary" },
    });
  });

  test("backs the file up first, and uninstall puts it back exactly", async () => {
    const path = join(dir, "config.toml");
    await Bun.write(path, PLAIN);
    const outcome = await installCodexStatusLine({ ...machine(), version: "0.171.0" });
    if (outcome.status !== "installed") throw new Error(`not installed: ${outcome.status}`);
    expect(await Bun.file(outcome.backup ?? "").text()).toBe(PLAIN);
    expect(await codexConfigured(path)).toBe(true);

    const again = await installCodexStatusLine({
      ...machine(),
      version: "0.171.0",
      record: { installed: true, ...outcome.record },
    });
    expect(again.status).toBe("already-installed");

    const removed = await uninstallCodexStatusLine(
      { installed: true, ...outcome.record },
      machine(),
    );
    expect(removed).toBe("removed");
    expect(await Bun.file(path).text()).toBe(PLAIN);
    expect(await codexConfigured(path)).toBe(false);
  });

  test("creates the file where Codex has none yet, with no backup to take", async () => {
    const outcome = await installCodexStatusLine({ ...machine(), version: "0.172.0" });
    if (outcome.status !== "installed") throw new Error(`not installed: ${outcome.status}`);
    expect(outcome.backup).toBeNull();
    expect(await codexConfigured(join(dir, "config.toml"))).toBe(true);
  });

  test("writes through a symlink, so a dotfiles-managed config stays managed", async () => {
    const real = join(dir, "dotfiles-config.toml");
    const path = join(dir, "config.toml");
    await Bun.write(real, PLAIN);
    await symlink(real, path);
    await installCodexStatusLine({ ...machine(), version: "0.171.0" });
    expect(await codexConfigured(real)).toBe(true);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

test("the block printed for a hand edit is the config install writes", () => {
  const plan = planned(planCodexInstall("", { argv: ARGV }));
  expect(parseToml(codexConfigBlock(ARGV))).toEqual(parseToml(plan.next));
});

describe("the renderer's host flag", () => {
  test("is read back as Codex", () => {
    expect(agentFromArgv(["--agent", "codex"])).toBe("codex");
    expect(agentFromArgv(["--agent=codex"])).toBe("codex");
    // Every existing install runs the flagless command; it must keep meaning Claude.
    expect(agentFromArgv([])).toBe("claude-code");
  });

  test("and a host this build does not know is refused rather than called Claude Code", () => {
    // A host newer than this client would otherwise bill its lines as the status line's.
    expect(agentFromArgv(["--agent", "nonsense"])).toBeNull();
    expect(agentFromArgv(["--agent=nonsense"])).toBeNull();
    expect(agentFromArgv(["--agent"])).toBeNull();
  });
});

describe("where the provider is told Codex's config is", () => {
  test("nowhere, for a Codex that keeps it in ~/.codex", () => {
    expect(codexProviderArgv({})).not.toContain("--codex-home");
    expect(codexProviderArgv({}).at(-1)).toBe("codex-provider");
  });

  test("as an argument where CODEX_HOME is set, since Codex does not pass the variable on", () => {
    const argv = codexProviderArgv({ CODEX_HOME: "/somewhere/else" });
    expect(argv.at(-2)).toBe("--codex-home");
    expect(argv.indexOf("codex-provider")).toBe(argv.length - 3);
  });
});
