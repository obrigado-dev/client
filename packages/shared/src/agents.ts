/**
 * The hosts Obrigado knows about, as facts rather than as a list.
 *
 * ## Why this is one table and four derived views
 *
 * There were four hand-maintained lists of agents in this repo, each correct for its own
 * purpose and each unaware of the others:
 *
 *   - `client/version.ts` — everything that can report an impression.
 *   - `client/commands/install.ts` — what `obrigado install` can configure.
 *   - `client/session-state.ts` — which hosts are editors, polled differently from terminals.
 *   - `web/lib/harnesses.ts` — what the landing page shows a surface for.
 *
 * Those really are four different sets, so collapsing them into one list would be wrong. What
 * was wrong instead was that each was typed independently: nothing failed if an id was
 * misspelled in one of them, or if a host was dropped from the client while the landing page
 * went on advertising it. The web's ids were a separate string union with no relationship to
 * the client's at all.
 *
 * So the facts live here once and every list is `AGENTS.filter(...)`. Adding a host is one row;
 * the four views update themselves, and a row that contradicts itself fails to typecheck.
 *
 * ## Why `shared`
 *
 * `shared-imports-nothing-local` makes this package the leaf that every tier may import, which
 * is the only place all four consumers can reach. The web importing the client to read one
 * array would drag a published CLI's dependency tree into the site build.
 *
 * ## What `installs: "cli"` means, and the codex case
 *
 * It means this client owns the installer for that host — not that installing succeeds today.
 * Codex is the case that separates the two: `--agent codex` is accepted precisely so it can be
 * refused with the reason and a non-zero exit, rather than answering "Unsupported agent" to a
 * developer who asked for something real. Its surface is `null` because SPEC-AMENDMENTS A19
 * found none of Codex's reachable surfaces is a persistent host-owned line, so none is a
 * countable impression.
 *
 * That pairing — an installer we own, no surface to install into — is the honest description
 * of where Codex actually is, and it is why the landing page and the installer disagree about
 * it without either being wrong.
 */

/** How Obrigado gets into a host. `null` when nothing installs it yet. */
export type InstallMethod = "cli" | "marketplace";

export interface AgentFacts {
  readonly id: string;
  /** What the host calls itself, which is what a reader scans for. */
  readonly label: string;
  readonly installs: InstallMethod | null;
  /**
   * Editors are detected and polled differently from terminal agents: an editor window is
   * visible whether or not an agent is running in it, which is why §14's viewability rules
   * treat them separately.
   */
  readonly kind: "terminal" | "editor";
  /**
   * The documented surface it renders a status line on, in the host's own vocabulary, or
   * `null` when it has none that counts.
   *
   * This is the field the landing page filters on, and the sentence it prints under the demo.
   * A host with a surface here is one the product can be shown working in.
   */
  readonly surface: string | null;
  /**
   * The host whose surface this one inherits, when it is a fork rather than its own program.
   *
   * Cursor is a VS Code fork and runs the same extension unchanged. It stays a separate id
   * because the impression records which one rendered and the rollup will not join them back
   * together — but it is not a second surface, and anything showing surfaces should show one.
   */
  readonly inherits: string | null;
}

export const AGENTS = [
  {
    id: "claude-code",
    label: "Claude Code",
    installs: "cli",
    kind: "terminal",
    surface: "The status line, configured by the documented `statusLine` settings key.",
    inherits: null,
  },
  {
    id: "codex",
    label: "Codex",
    installs: "cli",
    kind: "terminal",
    // A19: a warning cell, an Enterprise-only push field, the model's own plan output and a
    // thread title. None is persistent and host-owned, so none is a countable impression.
    surface: null,
    inherits: null,
  },
  {
    id: "opencode",
    label: "OpenCode",
    installs: "cli",
    kind: "terminal",
    surface:
      "A plugin component in the host's own `app_bottom` slot, where the copy is a real link.",
    inherits: null,
  },
  {
    id: "vscode",
    label: "VS Code",
    installs: "marketplace",
    kind: "editor",
    surface: "A status bar item created with `vscode.window.createStatusBarItem`.",
    inherits: null,
  },
  {
    id: "cursor",
    label: "Cursor",
    installs: "marketplace",
    kind: "editor",
    surface: null,
    inherits: "vscode",
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    installs: null,
    kind: "terminal",
    surface: null,
    inherits: null,
  },
] as const satisfies readonly AgentFacts[];

/**
 * Every id, in declaration order.
 *
 * Append-only in practice: this is a rollup key on the server, so a name that has ever been
 * reported has to keep resolving even after nothing installs it any more.
 */
export type AgentId = (typeof AGENTS)[number]["id"];

/** Those `obrigado install` can configure. */
export type InstallableAgentId = Extract<(typeof AGENTS)[number], { installs: "cli" }>["id"];

/** Those with a surface worth showing — the ones a demo can honestly depict. */
export type SurfacedAgentId = Extract<(typeof AGENTS)[number], { surface: string }>["id"];

export const AGENT_IDS: readonly AgentId[] = AGENTS.map((agent) => agent.id);

export const INSTALLABLE_AGENTS = AGENTS.filter(
  (agent): agent is Extract<(typeof AGENTS)[number], { installs: "cli" }> =>
    agent.installs === "cli",
);

export const SURFACED_AGENTS = AGENTS.filter(
  (agent): agent is Extract<(typeof AGENTS)[number], { surface: string }> => agent.surface !== null,
);

export const EDITOR_AGENT_IDS: readonly AgentId[] = AGENTS.filter(
  (agent) => agent.kind === "editor",
).map((agent) => agent.id);

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}

/**
 * Whether a reported agent is one this build knows about.
 *
 * Deliberately NOT a validator that rejects. `agent` is a rollup key, and the two ways an
 * unrecognised one arrives are both routine: a client shipping a new host before the server
 * deploys, and an old client still reporting a name since removed from the table. Refusing
 * either turns a naming mismatch into a dropped billable impression, which is a far worse
 * failure than an untidy rollup.
 *
 * So the wire stays permissive, the raw value is stored as sent, and this exists to let the
 * ingest path notice. What it protects is the claim `version.ts` makes — that the set is
 * closed — which was true of the client and enforced nowhere on the server, so a typo could
 * quietly split one agent's traffic into two populations no query joins back together.
 *
 * Because the raw value is stored, "unknown" is derivable at any time; see the reconciliation
 * query in `docs/RUNBOOK.md`. Nothing here needs a migration.
 */
export function isKnownAgent(reported: string): boolean {
  return isAgentId(reported);
}

/**
 * First-party renderers that use the paid pipeline without being installable coding agents.
 *
 * Kept out of `AGENTS` so the client cannot accept `--agent obrigado-web` and the landing
 * harness does not grow a tab for its own containing page. It is still a known value in the
 * impression rollup, where every paid surface must name what rendered it.
 */
export const WEBSITE_RENDERER_ID = "obrigado-web";

export function isKnownRenderer(reported: string): boolean {
  return isKnownAgent(reported) || reported === WEBSITE_RENDERER_ID;
}

/**
 * What to call a surface that more than one host renders.
 *
 * "VS Code / Cursor" rather than two tabs showing the same extension. Composed from the facts
 * so that adding another fork is a row, not an edit to a label somewhere else.
 */
export function surfaceLabel(id: AgentId): string {
  const owner = AGENTS.find((agent) => agent.id === id);
  if (owner === undefined) return id;

  const inheritors = AGENTS.filter((agent) => agent.inherits === id).map((agent) => agent.label);
  return [owner.label, ...inheritors].join(" / ");
}
