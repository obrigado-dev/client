/**
 * The footer items that count something: the context window, the thread's tokens and cost, and
 * the account's rate limits.
 *
 * These are the items where the snapshot is furthest from the state Codex's own footer reads.
 * Codex sends the share of the window used where its footer computes the share left, a breakdown
 * of tokens where its footer adds them up, units where it holds micros, and two windows of a
 * limit where its footer picks one. Each function here goes back from what is sent to what is
 * drawn, and names the function of Codex 0.171.0 it follows (`codex-rs/tui/src/chatwidget` at
 * `rust-v0.171.0`). None of it shows in the running program without a model, so it is held to the
 * source and to upstream's tests.
 */
import {
  compactTokens,
  creditMicros,
  fixed,
  microsOf,
  usdMicros,
  windowLabel,
} from "./codex-footer-format.ts";
import type { Json, View } from "./codex-footer-state.ts";
import { at, finite, isRecord, whole } from "./codex-footer-state.ts";

function context(view: View): Json | null {
  const value = at(view.state, "thread", "usage", "context");
  return isRecord(value) ? value : null;
}

/**
 * Whether Codex is still waiting for a thread's token counts, `token_usage_pending` upstream,
 * which blanks the context and token items until they arrive.
 *
 * The snapshot does not carry the flag, but `used_percentage` is written whenever the window size
 * is known and the counts are not pending (`statusline_state/usage.rs`), so a window size without
 * a percentage is the flag set.
 *
 * Inferred: with no window size either, a thread nothing has been asked of yet (not pending:
 * Codex draws `Context 100% left` and `0 in`, checked against 0.171.0) looks the same as a resumed
 * one whose counts have not arrived (pending: Codex draws nothing). The first is every new
 * thread and the second lasts a moment, so this reads it as the first.
 */
function usagePending(usage: Json): boolean {
  return whole(usage["context_window_size"]) !== null && whole(usage["used_percentage"]) === null;
}

/**
 * The share of the context window still free: `status_line_context_remaining_percent` in
 * `status_controls.rs`. Codex sends the share used, which it makes from this one, so taking it
 * from 100 gives this one back. With no window size known Codex calls it 100.
 */
function contextRemaining(view: View): number | null {
  const usage = context(view);
  if (usage === null || usagePending(usage)) return null;
  if (whole(usage["context_window_size"]) === null) return 100;
  const used = whole(usage["used_percentage"]);
  return used === null ? null : 100 - Math.min(Math.max(used, 0), 100);
}

/** `Context 85% left`. */
export function contextLeft(view: View): string | null {
  const remaining = contextRemaining(view);
  return remaining === null ? null : `Context ${remaining}% left`;
}

/** `Context 15% used`. */
export function contextUsed(view: View): string | null {
  const remaining = contextRemaining(view);
  return remaining === null ? null : `Context ${100 - remaining}% used`;
}

function counted(count: number | null, unit: string): string | null {
  return count === null ? null : `${compactTokens(count)} ${unit}`;
}

/** `272K window`, left out until Codex knows the model's window. */
export function contextWindow(view: View): string | null {
  return counted(whole(context(view)?.["context_window_size"]), "window");
}

/**
 * One of the thread's token totals, as `Counts` in `statusline_state/usage.rs`. Codex leaves the
 * totals out before the first report and for a report with no breakdown, and in both the
 * built-in footer counts zero.
 */
function total(view: View, field: string): number | null {
  const usage = context(view);
  if (usage === null || usagePending(usage)) return null;
  const totals = at(view.state, "thread", "usage", "total");
  return totals === undefined ? 0 : whole(at(totals, field));
}

/** `1.23M in`. */
export function inputTokens(view: View): string | null {
  return counted(total(view, "total_input_tokens"), "in");
}

/** `45.7K out`. */
export function outputTokens(view: View): string | null {
  return counted(total(view, "output_tokens"), "out");
}

/**
 * `280K used`: input that was not read from cache, plus output (`blended_total` in
 * `tui/src/token_usage.rs`). Unlike the two totals, this item is left out while it is zero.
 */
export function usedTokens(view: View): string | null {
  const totals = at(view.state, "thread", "usage", "total");
  const input = whole(at(totals, "total_input_tokens"));
  const cached = whole(at(totals, "cache_read_input_tokens"));
  const output = whole(at(totals, "output_tokens"));
  if (input === null || cached === null || output === null) return null;
  const blended = Math.max(input - Math.max(cached, 0), 0) + Math.max(output, 0);
  return blended > 0 ? `${compactTokens(blended)} used` : null;
}

function costMicros(view: View, field: string): bigint | null {
  const units = finite(at(view.state, "thread", "usage", "cost", field));
  return units === null ? null : microsOf(units);
}

/** `5.2 credits`, which only an Enterprise workspace's thread has. */
export function threadCredits(view: View): string | null {
  const amount = costMicros(view, "total_credits");
  return amount === null ? null : `${creditMicros(amount)} credits`;
}

/** `~$0.21`, likewise. */
export function threadCost(view: View): string | null {
  const amount = costMicros(view, "total_cost_usd");
  return amount === null ? null : usdMicros(amount);
}

/** One window of a rate limit, `RateLimitWindow` in the snapshot. */
interface LimitWindow {
  readonly usedPercent: number;
  readonly label: string | null;
}

function limitWindow(value: unknown): LimitWindow | null {
  const usedPercent = finite(at(value, "used_percent"));
  if (usedPercent === null) return null;
  return { usedPercent, label: windowLabel(finite(at(value, "window_minutes"))) };
}

type PickedWindow = readonly [window: LimitWindow, secondary: boolean];
export type LimitItem = "five-hour" | "weekly";

/**
 * The five-hour item's window: `five_hour_status_window` in `status_surfaces.rs`, its four
 * helpers in their order. It takes the five-hour window, or failing that whichever window is not
 * the weekly one, so a plan with a monthly window shows `monthly` here.
 */
function fiveHourWindow(
  primary: LimitWindow | null,
  secondary: LimitWindow | null,
): PickedWindow | null {
  if (primary?.label === "5h") return [primary, false];
  const hasWeekly = primary?.label === "weekly" || secondary?.label === "weekly";
  if (hasWeekly && secondary?.label === "5h") return [secondary, true];
  if (primary === null) return null;
  if (primary.label !== "weekly") return [primary, false];
  return secondary !== null && secondary.label !== "weekly" ? [secondary, true] : null;
}

/** The weekly item's window: `weekly_status_window`. The weekly one, or else the second. */
function weeklyWindow(
  primary: LimitWindow | null,
  secondary: LimitWindow | null,
): PickedWindow | null {
  if (primary?.label === "weekly") return [primary, false];
  return secondary === null ? null : [secondary, true];
}

/**
 * `5h 62% left`: the window's name (`limit_label_for_window`, with `usage` and `secondary usage`
 * for a length that has none) and what is left of it (`status_line_limit_display`), from the
 * `codex` limit, the only one the footer reads.
 */
export function limitLeft(view: View, item: LimitItem): string | null {
  const limits = at(view.state, "account", "rate_limits");
  if (!Array.isArray(limits)) return null;
  const codex: unknown = limits.find((entry: unknown) => at(entry, "limit_id") === "codex");
  const primary = limitWindow(at(codex, "primary_limit"));
  const secondary = limitWindow(at(codex, "secondary_limit"));
  const picked =
    item === "weekly" ? weeklyWindow(primary, secondary) : fiveHourWindow(primary, secondary);
  if (picked === null) return null;

  const [window, isSecondary] = picked;
  const label = window.label ?? (isSecondary ? "secondary usage" : "usage");
  const remaining = Math.min(Math.max(100 - window.usedPercent, 0), 100);
  return `${label} ${fixed(remaining, 0)}% left`;
}
