/**
 * Every item Codex's footer can hold: where its text comes from, its colour, and the text.
 *
 * The table at the end is `StatusLineItem` of Codex 0.171.0 (`bottom_pane/status_line_setup.rs`
 * under `codex-rs/tui/src` at `rust-v0.171.0`), one entry an id, in upstream's order. An entry's
 * text mirrors that item's arm of `status_line_value_for_item` (`chatwidget/status_surfaces.rs`),
 * made from the snapshot as `chatwidget/statusline_state.rs` fills it, and its colour is
 * `StatusLineAccent::for_item` (`bottom_pane/status_line_style.rs`).
 *
 * Where the snapshot holds what Codex decided and not the state it decided from, the text is an
 * inference, marked "Inferred" beside it here and in the modules this one draws on.
 */
import { currentBranch, directoryDisplay, hostName, repositoryName } from "./codex-footer-local.ts";
import type { View } from "./codex-footer-state.ts";
import { at, isRecord, repository, text, workingDirectory } from "./codex-footer-state.ts";
import {
  contextLeft,
  contextUsed,
  contextWindow,
  inputTokens,
  limitLeft,
  outputTokens,
  threadCost,
  threadCredits,
  usedTokens,
} from "./codex-footer-usage.ts";

/** The colour roles Codex's footer names, `StatusLineAccent` upstream. */
type StatusColor =
  | "status-model"
  | "status-path"
  | "status-branch"
  | "status-state"
  | "status-usage"
  | "status-limit"
  | "status-metadata"
  | "status-mode"
  | "status-thread"
  | "status-progress";

/** Every id Codex 0.171.0 takes in `tui.status_line`, as it writes them in the snapshot. */
export type FooterItemId =
  | "model"
  | "model-with-reasoning"
  | "reasoning"
  | "current-dir"
  | "project-name"
  | "hostname"
  | "git-branch"
  | "pull-request-number"
  | "branch-changes"
  | "run-state"
  | "permissions"
  | "approval-mode"
  | "context-remaining"
  | "context-used"
  | "five-hour-limit"
  | "weekly-limit"
  | "codex-version"
  | "context-window-size"
  | "used-tokens"
  | "total-input-tokens"
  | "total-output-tokens"
  | "thread-credits"
  | "estimated-thread-cost"
  | "thread-id"
  | "fast-mode"
  | "daybreak"
  | "raw-output"
  | "thread-name"
  | "thread-title"
  | "workspace-headline"
  | "task-progress"
  | "profile"
  | "provider";

/**
 * Where an item's text comes from: the snapshot alone, the snapshot's working directory and a
 * fact about this machine, or nowhere a provider can reach.
 */
export type FooterItemSource = "snapshot" | "local" | "unredrawable";

export interface FooterItem {
  readonly source: FooterItemSource;
  readonly color: StatusColor;
  /** The item's text, or null where upstream's value is `None` and the item is skipped. */
  readonly value: (view: View) => string | null;
}

function model(view: View): unknown {
  return at(view.state, "thread", "model");
}

function modelName(view: View): string | null {
  return text(at(model(view), "display_name"));
}

/**
 * `status_line_reasoning_effort_label` in `status_controls.rs`: the effort's wire name, and
 * `default` when the model has none or it is `none`. The snapshot leaves the field out for none.
 */
function reasoning(view: View): string | null {
  if (!isRecord(model(view))) return null;
  const level = text(at(model(view), "reasoning_level"));
  return level === null || level === "none" ? "default" : level;
}

/**
 * `model_with_reasoning_display_name`: the model, the effort, and the service tier's name in
 * lower case when the thread runs on one (`gpt-5.2 high fast`).
 *
 * Inferred: the snapshot holds the tier back until the thread's settings are confirmed, a moment
 * at the start of a thread somebody else started. Until then this draws no tier.
 */
function modelWithReasoning(view: View): string | null {
  const name = modelName(view);
  const effort = reasoning(view);
  if (name === null || effort === null) return null;
  const tier = text(at(model(view), "service_tier_display_name"));
  return tier === null ? `${name} ${effort}` : `${name} ${effort} ${tier.toLowerCase()}`;
}

/**
 * The service tier's name, or `Standard` without one. `service_tier` is in the snapshot exactly
 * when the settings are confirmed, and before that the tier is not known, so nothing is drawn.
 */
function fastMode(view: View): string | null {
  if (text(at(model(view), "service_tier")) === null) return null;
  return text(at(model(view), "service_tier_display_name")) ?? "Standard";
}

/**
 * Whether Daybreak is on for the thread.
 *
 * Inferred: the snapshot carries the access program Codex will ask for, not the switch. A
 * `daybreak_*` program means on and `standard` means off. With no program (an account or a model
 * outside Daybreak, which is what a session without one shows, checked against 0.171.0) the
 * switch cannot be seen, and it is drawn off, which it is unless the developer turned it on where
 * Codex refuses to run with it.
 */
function daybreak(view: View): string | null {
  if (!isRecord(model(view))) return null;
  const program = text(at(model(view), "access_program"));
  return program?.startsWith("daybreak") === true ? "Daybreak on" : "Daybreak off";
}

/** The run state with a capital, which is how upstream's enum prints (`run_state_status_text`). */
const RUN_STATES: Readonly<Record<string, string>> = {
  starting: "Starting",
  ready: "Ready",
  working: "Working",
  waiting: "Waiting",
  thinking: "Thinking",
};

function runState(view: View): string | null {
  const state = text(at(view.state, "thread", "agent", "state"));
  return state !== null && Object.hasOwn(RUN_STATES, state) ? (RUN_STATES[state] ?? null) : null;
}

/**
 * `approval_mode_display` in `status_surfaces.rs`: asking on request reads as who answers, and any
 * other policy as its own name. The snapshot has no approval until the settings are confirmed.
 */
function approvalMode(view: View): string | null {
  const policy = text(at(view.state, "thread", "approval", "policy"));
  if (policy === "on-request") {
    const reviewer = at(view.state, "thread", "approval", "reviewer");
    if (reviewer === "auto-review") return "Approve for me";
    return reviewer === "user" ? "Ask for approval" : null;
  }
  return policy === "untrusted" || policy === "granular" || policy === "never" ? policy : null;
}

/**
 * `workspace_directory_display`: the working directory, with home written `~`.
 *
 * Inferred: a session attached to a remote Codex draws the path whole, since `~` would be the
 * wrong machine's home, and the snapshot does not say the session is remote.
 */
function currentDirectory(view: View): string | null {
  const cwd = workingDirectory(view);
  return cwd === null ? null : directoryDisplay(cwd, view.machine);
}

/**
 * The name of the directory the repository is in (`status_line_project_root_name`).
 *
 * Inferred: outside a repository Codex falls back to the directory holding the project's `.codex`
 * folder, if its configuration found one when it started. The snapshot does not say whether it
 * did, so there the item is left out.
 */
function projectName(view: View): string | null {
  const found = repository(view);
  return found === null ? null : repositoryName(found, view.machine);
}

function gitBranch(view: View): string | null {
  const found = repository(view);
  return found === null ? null : currentBranch(found, view.machine);
}

/**
 * The thread's name, already trimmed and null for an unnamed thread in the snapshot.
 *
 * Inferred: in a Codex Cloud thread the built-in footer puts a cloud sign before the name
 * (`ThreadLabelStyle`), and the snapshot does not say a thread is one.
 */
function threadName(view: View): string | null {
  const name = text(at(view.state, "thread", "name"));
  return name === null || name === "" ? null : name;
}

function threadId(view: View): string | null {
  const id = text(at(view.state, "thread", "id"));
  return id === null || id === "" ? null : id;
}

function labelled(label: string, value: string | null): string | null {
  return value === null ? null : `${label}: ${value}`;
}

function item(
  source: FooterItemSource,
  color: StatusColor,
  value: FooterItem["value"],
): FooterItem {
  return { source, color, value };
}

/** An item whose value is state the snapshot does not carry and this machine cannot supply. */
function unredrawable(color: StatusColor): FooterItem {
  return { source: "unredrawable", color, value: () => null };
}

export const FOOTER_ITEMS: Readonly<Record<FooterItemId, FooterItem>> = {
  model: item("snapshot", "status-model", modelName),
  "model-with-reasoning": item("snapshot", "status-model", modelWithReasoning),
  reasoning: item("snapshot", "status-model", reasoning),
  "current-dir": item("snapshot", "status-path", currentDirectory),
  "project-name": item("local", "status-path", projectName),
  hostname: item("local", "status-metadata", (view) => hostName(view.machine)),
  "git-branch": item("local", "status-branch", gitBranch),
  // The open pull request's number (`PR #12`), which Codex asks the `gh` program for.
  "pull-request-number": unredrawable("status-branch"),
  // Lines added and removed against the default branch (`+10 -2`), from git commands Codex runs.
  "branch-changes": unredrawable("status-branch"),
  "run-state": item("snapshot", "status-state", runState),
  // `permissions_display`, which the snapshot carries as it is once the settings are confirmed.
  permissions: item("snapshot", "status-mode", (view) =>
    text(at(view.state, "thread", "permissions", "display_name")),
  ),
  "approval-mode": item("snapshot", "status-mode", approvalMode),
  "context-remaining": item("snapshot", "status-usage", contextLeft),
  "context-used": item("snapshot", "status-usage", contextUsed),
  "five-hour-limit": item("snapshot", "status-limit", (view) => limitLeft(view, "five-hour")),
  "weekly-limit": item("snapshot", "status-limit", (view) => limitLeft(view, "weekly")),
  "codex-version": item("snapshot", "status-metadata", (view) =>
    text(at(view.state, "app", "cli_version")),
  ),
  "context-window-size": item("snapshot", "status-usage", contextWindow),
  "used-tokens": item("snapshot", "status-usage", usedTokens),
  "total-input-tokens": item("snapshot", "status-usage", inputTokens),
  "total-output-tokens": item("snapshot", "status-usage", outputTokens),
  "thread-credits": item("snapshot", "status-usage", threadCredits),
  "estimated-thread-cost": item("snapshot", "status-usage", threadCost),
  "thread-id": item("snapshot", "status-metadata", threadId),
  "fast-mode": item("snapshot", "status-mode", fastMode),
  daybreak: item("snapshot", "status-mode", daybreak),
  "raw-output": item("snapshot", "status-mode", (view) =>
    at(view.state, "app", "display_mode") === "raw" ? "raw output" : null,
  ),
  "thread-name": item("snapshot", "status-thread", threadName),
  "thread-title": item("snapshot", "status-thread", (view) => threadName(view) ?? threadId(view)),
  "workspace-headline": item("snapshot", "status-thread", (view) =>
    text(at(view.state, "account", "workspace", "headline")),
  ),
  // `Tasks 2/5`, from the agent's last `update_plan` call, which the snapshot does not carry.
  "task-progress": unredrawable("status-progress"),
  profile: item("snapshot", "status-metadata", (view) =>
    labelled("profile", text(at(view.state, "config", "profile"))),
  ),
  provider: item("snapshot", "status-model", (view) =>
    labelled("provider", text(at(model(view), "provider"))),
  ),
};

export function isFooterItemId(id: unknown): id is FooterItemId {
  return typeof id === "string" && Object.hasOwn(FOOTER_ITEMS, id);
}
