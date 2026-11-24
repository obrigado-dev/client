/**
 * The developer's Codex footer, drawn again (`codex-footer.ts`): the same items, text and
 * separator Codex 0.171.0 draws, from the snapshot it hands a provider.
 *
 * Where a test says "as Codex drew it", the snapshot is one a real Codex 0.171.0 sent to a
 * provider, and the expected line is what the same program drew in its built-in footer for the
 * same thread settings, captured from a terminal. Token counts, rate limits and thread cost
 * cannot be had from Codex without a model, so those follow its source and its own tests.
 */
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ITEMS,
  FOOTER_ITEM_SOURCES,
  FOOTER_MAX_NODES,
  FOOTER_MAX_TEXT_BYTES,
  redrawFooter,
  UNREDRAWABLE_ITEMS,
} from "../src/codex-footer.ts";
import type { FooterMachine } from "../src/codex-footer.ts";
import { validTree } from "../src/codex-tree.ts";
import type { UiNode } from "../src/codex-tree.ts";

const HOME = "/Users/dev";
const REPO = `${HOME}/Code/app`;
const THREAD_ID = "01a20ae9-faf5-7630-857a-e9110f6d45eb";

/** A path with its `..` steps taken, as a disk takes them. */
function resolved(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** A machine whose disk is the given files and nothing else. */
function machineWith(
  files: Readonly<Record<string, string>>,
  extra: Partial<FooterMachine> = {},
): FooterMachine {
  const paths = Object.keys(files);
  return {
    home: HOME,
    hostname: "Devs-MacBook-Pro.local",
    readFile: (path) => files[resolved(path)] ?? null,
    exists: (path) =>
      paths.some((file) => file === resolved(path) || file.startsWith(`${resolved(path)}/`)),
    now: 1_795_480_000_000,
    ...extra,
  };
}

/** A repository at `REPO` on the branch `feat/statusline`. */
const IN_REPO = machineWith({ [`${REPO}/.git/HEAD`]: "ref: refs/heads/feat/statusline\n" });
const NO_REPO = machineWith({});

const ALL_ITEMS = Object.keys(FOOTER_ITEM_SOURCES);

/** A thread well under way, with every optional field Codex 0.171.0 can send. */
function fullState(items: readonly string[] = ALL_ITEMS): Record<string, unknown> {
  return {
    account: {
      rate_limits: [
        {
          limit_id: "codex",
          limit_name: null,
          primary_limit: { used_percent: 37.5, window_minutes: 300, resets_at: 1_795_490_000 },
          secondary_limit: { used_percent: 12, window_minutes: 10_080, resets_at: 1_795_990_000 },
        },
      ],
      workspace: { headline: "Maintenance on Friday" },
    },
    app: { cli_version: "0.171.0", display_mode: "raw" },
    config: { statusline_items: items, profile: "work" },
    thread: {
      id: THREAD_ID,
      name: "Fix the footer",
      agent: { state: "thinking" },
      model: {
        access_program: "daybreak_blue",
        display_name: "GPT-5.2 Codex",
        id: "gpt-5.2-codex",
        provider: "openai",
        reasoning_level: "high",
        service_tier: "fast",
        service_tier_display_name: "Fast",
      },
      workspace: { cwd: `${REPO}/packages/web` },
      usage: {
        context: { context_window_size: 272_000, used_tokens: 51_234, used_percentage: 15 },
        total: {
          total_input_tokens: 1_234_567,
          cache_read_input_tokens: 1_000_000,
          cache_write_input_tokens: 0,
          other_input_tokens: 234_567,
          output_tokens: 45_678,
        },
        cost: { total_cost_usd: 0.2143, total_credits: 5.2 },
      },
      approval: { policy: "on-request", reviewer: "auto-review" },
      permissions: {
        display_name: "Workspace",
        profile_id: ":workspace",
        type: "managed",
        file_system: { type: "restricted" },
        network: "restricted",
      },
    },
  };
}

/**
 * The snapshot Codex 0.171.0 sent for a thread nothing had been asked of yet, in a subdirectory
 * of a repository under home, with every item configured. Only the paths are rewritten.
 */
function freshState(items: readonly string[] = ALL_ITEMS): Record<string, unknown> {
  return {
    account: { rate_limits: [] },
    app: { cli_version: "0.171.0", display_mode: "standard" },
    config: { statusline_items: items },
    thread: {
      id: THREAD_ID,
      name: null,
      agent: { state: "ready" },
      model: {
        display_name: "dead-model",
        id: "dead-model",
        provider: "dead",
        service_tier: "normal",
      },
      workspace: { cwd: `${REPO}/sub` },
      usage: { context: {} },
      approval: { policy: "on-request", reviewer: "user" },
      permissions: {
        display_name: "Workspace",
        profile_id: ":workspace",
        type: "managed",
        file_system: { type: "restricted" },
        network: "restricted",
      },
    },
  };
}

type Thread = Record<string, unknown>;

/** `fullState` with one field of the thread set. */
function threadState(key: string, value: unknown, items: readonly string[]): unknown {
  return withThread((thread) => {
    thread[key] = value;
  }, items);
}

/** `fullState` with the thread changed. */
function withThread(change: (thread: Thread) => void, items?: readonly string[]): unknown {
  const state = fullState(items);
  change(state["thread"] as Thread);
  return state;
}

function rowChildren(tree: UiNode | null): readonly UiNode[] {
  if (tree === null || typeof tree === "string" || tree.type !== "row") return [];
  return tree.children;
}

function leafOf(node: UiNode): string {
  return typeof node === "string" ? node : node.children.map((child) => leafOf(child)).join("");
}

/** The footer as a terminal shows it: the row's children, a gap of one column between them. */
function line(tree: UiNode | null): string {
  return rowChildren(tree)
    .map((child) => leafOf(child))
    .join(" ");
}

function plain(state: unknown, machine: FooterMachine = IN_REPO): string {
  return line(redrawFooter(state, machine, { useColors: false }));
}

/** One item's text from `fullState`, changed as given. */
function one(item: string, change: (thread: Thread) => void): string {
  return plain(withThread(change, [item]));
}

/** One item's text with a field of the thread set, or taken away when no value is given. */
function threadWith(item: string, key: string, value?: unknown): string {
  return one(item, (thread) => {
    if (value === undefined) delete thread[key];
    else thread[key] = value;
  });
}

/** The same for a field of the thread's model. */
function modelWith(item: string, key: string, value?: unknown): string {
  return one(item, (thread) => {
    const model = thread["model"] as Thread;
    if (value === undefined) delete model[key];
    else model[key] = value;
  });
}

/** One item's text before the thread's settings are confirmed, when Codex holds them back. */
function unconfirmed(item: string): string {
  return one(item, (thread) => {
    thread["model"] = { display_name: "GPT-5.2 Codex", provider: "openai" };
    delete thread["approval"];
    delete thread["permissions"];
  });
}

/** The approval item's text for a policy and who answers it. */
function approval(policy: string, reviewer: string): string {
  return threadWith("approval-mode", "approval", { policy, reviewer });
}

/** The colour an item is drawn in. */
function colorOf(item: string): unknown {
  const [node] = rowChildren(redrawFooter(fullState([item]), IN_REPO, { useColors: true }));
  return typeof node === "object" && node.type === "text" ? node.props?.color : undefined;
}

/** The leaves a thread's name is drawn as. */
function nameLeaves(name: string): readonly UiNode[] {
  const state = withThread(
    (thread) => {
      thread["name"] = name;
    },
    ["thread-name"],
  );
  return rowChildren(redrawFooter(state, IN_REPO, { useColors: false }));
}

function directoryShown(cwd: string, machine: FooterMachine = NO_REPO): string {
  return plain(threadState("workspace", { cwd }, ["current-dir"]), machine);
}

function hostShown(hostname: string | null): string {
  return plain(fullState(["hostname"]), machineWith({}, { hostname }));
}

/** The project and the branch for a working directory on a disk of the given files. */
function git(cwd: string, files: Readonly<Record<string, string>>): string {
  const state = threadState("workspace", { cwd }, ["project-name", "git-branch"]);
  return plain(state, machineWith(files));
}

/** A tree's size as Codex counts it: its nodes, the bytes of its leaves, its depth. */
function measure(tree: UiNode | null): { nodes: number; bytes: number; depth: number } {
  const totals = { nodes: 0, bytes: 0, depth: 0 };
  const visit = (node: UiNode, depth: number): void => {
    totals.nodes += 1;
    totals.depth = Math.max(totals.depth, depth);
    if (typeof node === "string") totals.bytes += Buffer.byteLength(node, "utf8");
    else for (const child of node.children) visit(child, depth + 1);
  };
  if (tree !== null) visit(tree, 0);
  return totals;
}

describe("a thread well under way", () => {
  test("draws every item it can, in the developer's order, with Codex's text", () => {
    expect(plain(fullState()).split(" · ")).toEqual([
      "GPT-5.2 Codex",
      "GPT-5.2 Codex high fast",
      "high",
      "~/Code/app/packages/web",
      "app",
      "devs-macbook-pro.local",
      "feat/statusline",
      "Thinking",
      "Workspace",
      "Approve for me",
      "Context 85% left",
      "Context 15% used",
      "5h 62% left",
      "weekly 88% left",
      "0.171.0",
      "272K window",
      "280K used",
      "1.23M in",
      "45.7K out",
      "5.2 credits",
      "~$0.21",
      THREAD_ID,
      "Fast",
      "Daybreak on",
      "raw output",
      "Fix the footer",
      "Fix the footer",
      "Maintenance on Friday",
      "profile: work",
      "provider: openai",
    ]);
  });

  test("is one wrapping row with a bare separator between items", () => {
    const tree = redrawFooter(fullState(["model", "run-state", "codex-version"]), IN_REPO, {
      useColors: false,
    });
    expect(tree).toEqual({
      type: "row",
      props: { gap: 1, wrap: "wrap" },
      children: ["GPT-5.2 Codex", "·", "Thinking", "·", "0.171.0"],
    });
  });

  test("keeps the order and the repeats of the developer's list", () => {
    expect(plain(fullState(["run-state", "model", "run-state"]))).toBe(
      "Thinking · GPT-5.2 Codex · Thinking",
    );
  });
});

describe("a thread nothing has been asked of", () => {
  test("is drawn as Codex 0.171.0 drew it", () => {
    const machine = machineWith(
      { [`${REPO}/.git/HEAD`]: "ref: refs/heads/feat/statusline\n" },
      { hostname: "Amirs-MacBook-Pro.local" },
    );
    expect(plain(freshState(), machine)).toBe(
      "dead-model · dead-model default · default · ~/Code/app/sub · app · " +
        "amirs-macbook-pro.local · feat/statusline · Ready · Workspace · Ask for approval · " +
        "Context 100% left · Context 0% used · 0.171.0 · 0 in · 0 out · " +
        `${THREAD_ID} · Standard · Daybreak off · ${THREAD_ID} · provider: dead`,
    );
  });

  test("has the default items when the developer chose none", () => {
    expect(DEFAULT_ITEMS).toEqual(["model-with-reasoning", "current-dir", "thread-name"]);
    // Codex fills the list in with its defaults; an unnamed thread has no name to draw.
    expect(plain(freshState(DEFAULT_ITEMS))).toBe("dead-model default · ~/Code/app/sub");
    const state = freshState();
    state["config"] = {};
    expect(plain(state)).toBe("dead-model default · ~/Code/app/sub");
  });

  test("is nothing at all with an empty list, or when no item has a value", () => {
    expect(redrawFooter(freshState([]), IN_REPO, { useColors: true })).toBeNull();
    expect(
      redrawFooter(freshState(["thread-name", "raw-output", "profile"]), IN_REPO, {
        useColors: true,
      }),
    ).toBeNull();
  });
});

describe("colours", () => {
  test("give each item the role Codex gives it", () => {
    const roles: Readonly<Record<string, readonly string[]>> = {
      "status-model": ["model", "model-with-reasoning", "reasoning", "provider"],
      "status-path": ["current-dir", "project-name"],
      "status-branch": ["git-branch"],
      "status-state": ["run-state"],
      "status-usage": [
        "context-remaining",
        "context-used",
        "context-window-size",
        "used-tokens",
        "total-input-tokens",
        "total-output-tokens",
        "thread-credits",
        "estimated-thread-cost",
      ],
      "status-limit": ["five-hour-limit", "weekly-limit"],
      "status-metadata": ["codex-version", "hostname", "thread-id", "profile"],
      "status-mode": ["fast-mode", "daybreak", "raw-output", "permissions", "approval-mode"],
      "status-thread": ["thread-name", "thread-title", "workspace-headline"],
    };
    for (const [role, items] of Object.entries(roles)) {
      for (const item of items) expect([item, colorOf(item)]).toEqual([item, role]);
    }
  });

  test("leave the separator plain, and draw the same text as without them", () => {
    const tree = redrawFooter(fullState(["model", "current-dir"]), IN_REPO, { useColors: true });
    expect(tree).toEqual({
      type: "row",
      props: { gap: 1, wrap: "wrap" },
      children: [
        { type: "text", props: { color: "status-model" }, children: ["GPT-5.2 Codex"] },
        "·",
        {
          type: "text",
          props: { color: "status-path" },
          children: ["~/Code/app/packages/web"],
        },
      ],
    });
    expect(line(redrawFooter(fullState(), IN_REPO, { useColors: true }))).toBe(plain(fullState()));
  });
});

describe("the items a provider cannot draw", () => {
  test("are the three whose value is not in the snapshot or on this machine", () => {
    expect(UNREDRAWABLE_ITEMS).toEqual(["pull-request-number", "branch-changes", "task-progress"]);
    expect(plain(fullState([...UNREDRAWABLE_ITEMS, "model"]))).toBe("GPT-5.2 Codex");
  });

  test("leave every one of Codex's 33 items accounted for", () => {
    expect(ALL_ITEMS).toHaveLength(33);
    const local = Object.entries(FOOTER_ITEM_SOURCES)
      .filter(([, source]) => source === "local")
      .map(([id]) => id);
    expect(local).toEqual(["project-name", "hostname", "git-branch"]);
  });
});

describe("a snapshot that is not what it should be", () => {
  test("never throws and draws nothing it has no value for", () => {
    for (const state of [undefined, null, 42, "footer", [], {}, { thread: 7, config: [] }]) {
      expect(redrawFooter(state, NO_REPO, { useColors: true })).toBeNull();
    }
    const garbage = {
      account: { rate_limits: [null, 3, { limit_id: "codex", primary_limit: "soon" }] },
      app: { cli_version: 171, display_mode: ["raw"] },
      config: { statusline_items: [...ALL_ITEMS, 5, null, "no-such-item"], profile: {} },
      thread: {
        id: 12,
        name: ["x"],
        agent: { state: "dreaming" },
        model: "gpt",
        workspace: { cwd: null },
        usage: { context: "full", total: 9, cost: { total_cost_usd: "free", total_credits: -1 } },
        approval: { policy: "on-request", reviewer: "nobody" },
        permissions: null,
      },
    };
    expect(plain(garbage, machineWith({}, { hostname: null }))).toBe("");
  });

  test("loses only the items a wrong field belonged to", () => {
    const state = withThread((thread) => {
      thread["model"] = { display_name: 5, provider: "openai" };
      thread["usage"] = { context: { context_window_size: "big" } };
    });
    expect(plain(state).split(" · ")).toEqual([
      "default",
      "~/Code/app/packages/web",
      "app",
      "devs-macbook-pro.local",
      "feat/statusline",
      "Thinking",
      "Workspace",
      "Approve for me",
      "Context 100% left",
      "Context 0% used",
      "5h 62% left",
      "weekly 88% left",
      "0.171.0",
      "0 in",
      "0 out",
      THREAD_ID,
      "Daybreak off",
      "raw output",
      "Fix the footer",
      "Fix the footer",
      "Maintenance on Friday",
      "profile: work",
      "provider: openai",
    ]);
  });

  test("survives a machine whose reads throw", () => {
    const broken = machineWith(
      {},
      {
        readFile: () => {
          throw new Error("EACCES");
        },
        exists: () => {
          throw new Error("EACCES");
        },
      },
    );
    expect(plain(fullState(["git-branch", "project-name", "model"]), broken)).toBe("GPT-5.2 Codex");
  });
});

describe("the model, its effort and its tier", () => {
  test("call an absent effort, or none, the default", () => {
    expect(modelWith("reasoning", "reasoning_level")).toBe("default");
    expect(modelWith("reasoning", "reasoning_level", "none")).toBe("default");
    expect(modelWith("reasoning", "reasoning_level", "xhigh")).toBe("xhigh");
  });

  test("draw no tier, and no fast mode, until the thread's settings are confirmed", () => {
    expect(unconfirmed("model-with-reasoning")).toBe("GPT-5.2 Codex default");
    expect(unconfirmed("fast-mode")).toBe("");
    expect(unconfirmed("permissions")).toBe("");
    expect(unconfirmed("approval-mode")).toBe("");
  });

  test("call a thread on no tier Standard, as Codex 0.171.0 drew it", () => {
    expect(modelWith("fast-mode", "service_tier_display_name")).toBe("Standard");
    expect(modelWith("model-with-reasoning", "service_tier_display_name")).toBe(
      "GPT-5.2 Codex high",
    );
  });

  test("read Daybreak from the access program", () => {
    expect(modelWith("daybreak", "access_program", "daybreak_red")).toBe("Daybreak on");
    expect(modelWith("daybreak", "access_program", "standard")).toBe("Daybreak off");
    // No program at all is what Codex 0.171.0 sent where it drew "Daybreak off".
    expect(modelWith("daybreak", "access_program")).toBe("Daybreak off");
  });

  test("name an approval policy as Codex does", () => {
    // The first is what Codex 0.171.0 drew; a session whose policy was granular drew "granular".
    expect(approval("on-request", "user")).toBe("Ask for approval");
    expect(approval("on-request", "auto-review")).toBe("Approve for me");
    expect(approval("untrusted", "user")).toBe("untrusted");
    expect(approval("granular", "user")).toBe("granular");
    expect(approval("never", "auto-review")).toBe("never");
  });

  test("capitalise every run state", () => {
    const states = ["starting", "ready", "working", "waiting", "thinking"].map((state) =>
      threadWith("run-state", "agent", { state }),
    );
    expect(states).toEqual(["Starting", "Ready", "Working", "Waiting", "Thinking"]);
  });

  test("draw raw output only while it is on, as Codex 0.171.0 drew it", () => {
    expect(plain(fullState(["raw-output"]))).toBe("raw output");
    expect(plain(freshState(["raw-output", "run-state"]))).toBe("Ready");
  });
});

describe("the thread's name", () => {
  test("falls back to the id for the title only, as Codex 0.171.0 drew an unnamed thread", () => {
    expect(threadWith("thread-name", "name", null)).toBe("");
    expect(threadWith("thread-title", "name", null)).toBe(THREAD_ID);
  });

  test("keeps its inner spaces, as Codex 0.171.0 drew a name with two", () => {
    // The second space is a no-break space, which a tree draws where it would drop a space.
    expect(nameLeaves("Fix  the footer")).toEqual(["Fix \u00A0the footer"]);
    expect(nameLeaves(" padded ")).toEqual(["\u00A0padded\u00A0"]);
  });

  test("loses control characters, so it cannot break the line or reach the terminal", () => {
    expect(nameLeaves("one\ntwo\tthree\u001B[31m\u0007\u009B")).toEqual(["onetwothree[31m"]);
    expect(nameLeaves("half \uD83D of a pair")).toEqual(["half \uFFFD of a pair"]);
  });
});

describe("the working directory", () => {
  test("writes home as ~, as Codex 0.171.0 drew it", () => {
    expect(directoryShown(HOME)).toBe("~");
    expect(directoryShown(`${HOME}/proj/sub`)).toBe("~/proj/sub");
  });

  test("is whole outside home, and beside a directory that only starts like it", () => {
    expect(directoryShown("/private/tmp/work")).toBe("/private/tmp/work");
    expect(directoryShown("/Users/developer/app")).toBe("/Users/developer/app");
    expect(directoryShown("relative/path")).toBe("relative/path");
  });

  test("follows Windows paths on Windows", () => {
    const windows = machineWith({}, { home: "C:\\Users\\dev", platform: "win32" });
    expect(directoryShown("C:\\Users\\dev\\Code\\app", windows)).toBe("~\\Code\\app");
    expect(directoryShown("D:\\work", windows)).toBe("D:\\work");
  });
});

describe("the hostname", () => {
  test("is in lower case, as Codex 0.171.0 drew this one", () => {
    expect(hostShown("Amirs-MacBook-Pro.local")).toBe("amirs-macbook-pro.local");
  });

  test("is trimmed and loses a trailing dot", () => {
    expect(hostShown(" Build-01.CI.example.com. ")).toBe("build-01.ci.example.com");
  });

  test("is left out when the machine has none", () => {
    expect(hostShown(null)).toBe("");
    expect(hostShown(" . ")).toBe("");
  });
});

describe("the branch and the project", () => {
  const WORKTREE = `${HOME}/Code/wt`;
  test("are the repository's, from a subdirectory, as Codex 0.171.0 drew them", () => {
    const files = { [`${REPO}/.git/HEAD`]: "ref: refs/heads/feat/statusline\n" };
    expect(git(`${REPO}/sub`, files)).toBe("app · feat/statusline");
    expect(git(REPO, files)).toBe("app · feat/statusline");
  });

  test("follow a linked worktree's .git file, as Codex 0.171.0 drew them", () => {
    const files = {
      [`${REPO}/.git/HEAD`]: "ref: refs/heads/main\n",
      [`${REPO}/.git/worktrees/wt/HEAD`]: "ref: refs/heads/wt-branch\n",
      [`${REPO}/.git/worktrees/wt/commondir`]: "../..\n",
      [`${WORKTREE}/.git`]: `gitdir: ${REPO}/.git/worktrees/wt\n`,
    };
    expect(git(`${WORKTREE}/src`, files)).toBe("wt · wt-branch");
  });

  test("follow a .git file that names its directory relatively, as a submodule's does", () => {
    const files = {
      [`${REPO}/.git/HEAD`]: "ref: refs/heads/main\n",
      [`${REPO}/.git/modules/lib/HEAD`]: "ref: refs/heads/vendored\n",
      [`${REPO}/lib/.git`]: "gitdir: ../.git/modules/lib\n",
    };
    expect(git(`${REPO}/lib`, files)).toBe("lib · vendored");
  });

  test("name no branch on a detached HEAD, as Codex 0.171.0 drew it", () => {
    const files = { [`${REPO}/.git/HEAD`]: "c410ad845e5dde6d0ae156b8979b86b36860d473\n" };
    expect(git(REPO, files)).toBe("app");
  });

  test("name a branch that has no commit yet, as Codex 0.171.0 drew it", () => {
    expect(git(REPO, { [`${REPO}/.git/HEAD`]: "ref: refs/heads/not-yet-born\n" })).toBe(
      "app · not-yet-born",
    );
  });

  test("are both left out outside a repository, as Codex 0.171.0 drew it", () => {
    expect(git(`${HOME}/notes`, {})).toBe("");
    // A `.git` directory with no HEAD is not a repository to Codex or to git.
    expect(git(`${HOME}/notes`, { [`${HOME}/notes/.git/config`]: "" })).toBe("");
  });

  test("follow a branch that is a name for another, as git does", () => {
    const files = {
      [`${REPO}/.git/HEAD`]: "ref: refs/heads/main\n",
      [`${REPO}/.git/refs/heads/main`]: "ref: refs/heads/master\n",
      [`${REPO}/.git/refs/heads/master`]: "c410ad845e5dde6d0ae156b8979b86b36860d473\n",
    };
    expect(git(REPO, files)).toBe("app · master");
  });

  test("name no branch where git would not: outside refs/heads, reftable, a bad .git file", () => {
    expect(git(REPO, { [`${REPO}/.git/HEAD`]: "ref: refs/remotes/origin/main\n" })).toBe("app");
    expect(git(REPO, { [`${REPO}/.git/HEAD`]: "ref: refs/heads/.invalid\n" })).toBe("app");
    expect(git(REPO, { [`${REPO}/.git/HEAD`]: "ref: refs/heads/../../../etc/passwd\n" })).toBe(
      "app",
    );
    expect(git(REPO, { [`${REPO}/.git`]: "not a pointer\n" })).toBe("app");
    expect(git(REPO, { [`${REPO}/.git`]: `gitdir: ${REPO}/gone\n` })).toBe("app");
  });
});

describe("the tree stays inside what Codex accepts", () => {
  test("for every item at once", () => {
    const tree = redrawFooter(fullState(), IN_REPO, { useColors: true });
    expect(validTree(tree)).toBe(true);
    // A row, thirty items of a text node and its leaf each, and the separators between them.
    expect(measure(tree)).toMatchObject({ nodes: 1 + 30 * 2 + 29, depth: 2 });
    expect(measure(tree).bytes).toBeLessThan(FOOTER_MAX_TEXT_BYTES);
  });

  test("for a list far longer than a footer, and a name far longer than a line", () => {
    const items = Array.from({ length: 500 }, (_, index) =>
      index % 2 === 0 ? "thread-name" : "workspace-headline",
    );
    const state = withThread((thread) => {
      thread["name"] = 'é"\\'.repeat(500);
    }, items);
    (state as Record<string, Record<string, unknown>>)["account"] = {
      workspace: { headline: "🙂".repeat(2_000) },
    };
    for (const useColors of [true, false]) {
      const tree = redrawFooter(state, IN_REPO, { useColors });
      const size = measure(tree);
      expect(validTree(tree)).toBe(true);
      expect(size.nodes).toBeLessThanOrEqual(FOOTER_MAX_NODES);
      expect(size.bytes).toBeLessThanOrEqual(FOOTER_MAX_TEXT_BYTES);
      expect(size.depth).toBeLessThanOrEqual(2);
      expect(Buffer.byteLength(JSON.stringify(tree), "utf8")).toBeLessThan(64 * 1024);
      // The cut falls between characters: nothing is left of half an emoji.
      expect(JSON.stringify(tree)).not.toContain("\\ud83d");
    }
  });

  test("with as many items as fit", () => {
    const items = Array.from({ length: 500 }, () => "run-state");
    const tree = redrawFooter(fullState(items), IN_REPO, { useColors: true });
    expect(measure(tree).nodes).toBe(FOOTER_MAX_NODES);
    expect(validTree(tree)).toBe(true);
  });
});
