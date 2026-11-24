/**
 * The numbers in Codex's footer, written the way Codex writes them: token counts, credits,
 * dollars, and the name of a rate limit's window.
 *
 * Each function is a port of one in Codex 0.171.0's TUI (`codex-rs/tui/src` at `rust-v0.171.0`),
 * named beside it. None of them could be seen in the running program, which shows these only once
 * a model has answered, so they are held to the source and to the cases in upstream's own tests.
 */

/**
 * A non-negative number to a fixed count of decimals, the way Rust's `{:.N}` writes an `f64`:
 * from the exact value of the double, and a tie to the even digit. `toFixed` takes a tie upward
 * (`(62.5).toFixed(0)` is `63` where Codex writes `62`), so the digits are worked out in whole
 * numbers instead. Doubling a double is exact, which gets its exact value as a fraction.
 */
export function fixed(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return String(value);
  let numerator = value;
  let denominator = 1n;
  while (!Number.isInteger(numerator)) {
    numerator *= 2;
    denominator *= 2n;
  }
  const scaled = BigInt(numerator) * 10n ** BigInt(decimals);
  let quotient = scaled / denominator;
  const twiceRest = (scaled % denominator) * 2n;
  if (twiceRest > denominator || (twiceRest === denominator && quotient % 2n === 1n)) {
    quotient += 1n;
  }
  const digits = quotient.toString().padStart(decimals + 1, "0");
  return decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/**
 * A token count in at most three significant digits: `format_tokens_compact` in
 * `status/helpers.rs`. A count that would round to 1000 of one unit is written in the next.
 */
export function compactTokens(count: number): string {
  const value = Math.max(count, 0);
  if (value < 1_000) return String(value);

  let scaled = value / 1_000;
  let suffix = "K";
  if (value >= 999_500_000_000) {
    scaled = value / 1_000_000_000_000;
    suffix = "T";
  } else if (value >= 999_500_000) {
    scaled = value / 1_000_000_000;
    suffix = "B";
  } else if (value >= 999_500) {
    scaled = value / 1_000_000;
    suffix = "M";
  }

  let decimals = 0;
  if (scaled < 10) decimals = 2;
  else if (scaled < 100) decimals = 1;
  let formatted = fixed(scaled, decimals);
  if (formatted.includes(".")) formatted = formatted.replace(/0+$/u, "").replace(/\.$/u, "");
  return `${formatted}${suffix}`;
}

/**
 * Millionths of a credit or a dollar, from the units the snapshot carries. Codex holds whole
 * micros and divides by a million for the snapshot (`chatwidget/statusline_state/usage.rs`),
 * dropping a negative amount, so rounding the product gives its number back.
 */
export function microsOf(units: number): bigint | null {
  if (!Number.isFinite(units) || units < 0) return null;
  const rounded = Math.round(units * 1_000_000);
  return Number.isSafeInteger(rounded) ? BigInt(rounded) : null;
}

/** Credits to one decimal place: `format_credit_micros` in `status/thread_usage.rs`. */
export function creditMicros(amount: bigint): string {
  const units: readonly (readonly [bigint, string])[] = [
    [10n ** 18n, "T"],
    [10n ** 15n, "B"],
    [10n ** 12n, "M"],
    [10n ** 9n, "K"],
  ];
  const [unit, suffix] = units.find(([size]) => amount >= size) ?? [1_000_000n, ""];
  const tenths = (amount * 10n + unit / 2n) / unit;
  const fraction = tenths % 10n;
  return fraction === 0n ? `${tenths / 10n}${suffix}` : `${tenths / 10n}.${fraction}${suffix}`;
}

/**
 * Dollars to the cent, or to more places for an amount under a cent: `format_estimated_usd_micros`
 * in `status/thread_usage.rs`.
 */
export function usdMicros(amount: bigint): string {
  if (amount > 0n && amount < 100n) return `~$0.${amount.toString().padStart(6, "0")}`;
  if (amount > 0n && amount < 10_000n) {
    return `~$0.${((amount + 50n) / 100n).toString().padStart(4, "0")}`;
  }
  const cents = (amount + 5_000n) / 10_000n;
  return `~$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/**
 * What a rate limit's window is called by its length, within 5% either way, or null for a length
 * with no name: `get_limits_duration` in `chatwidget/rate_limits.rs`.
 */
export function windowLabel(minutes: number | null): string | null {
  if (minutes === null) return null;
  const length = Math.max(minutes, 0);
  const durations: readonly (readonly [number, string])[] = [
    [5 * 60, "5h"],
    [24 * 60, "daily"],
    [7 * 24 * 60, "weekly"],
    [30 * 24 * 60, "monthly"],
    [365 * 24 * 60, "annual"],
  ];
  for (const [expected, label] of durations) {
    if (length >= expected * 0.95 && length <= expected * 1.05) return label;
  }
  return null;
}
