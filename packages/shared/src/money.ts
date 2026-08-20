/**
 * Money. INVARIANT 1: integer micros everywhere, no floats in any layer.
 *
 * `Micros` is a branded `bigint`, which makes the invariant structural rather
 * than aspirational:
 *
 *   - You cannot mix a bigint and a number in JS arithmetic at all — `1n + 1`
 *     is a TypeScript error and a runtime TypeError. Float contamination in a
 *     money expression is therefore not a code-review question.
 *   - Arithmetic on two `Micros` widens to plain `bigint`, so the result will
 *     not assign back to a `Micros` binding. That forces every operation
 *     through the helpers below, which is where the invariants are asserted.
 *   - The brand means a raw `bigint` (a row id, a count) cannot be passed where
 *     money is expected.
 *
 * The only places a `number` may touch money are the two codecs at the wire
 * boundary, which validate integrality and safe range explicitly.
 */

declare const MICROS_BRAND: unique symbol;

export type Micros = bigint & { readonly [MICROS_BRAND]: "Micros" };

/** 1 USD = 1,000,000 micros. */
export const USD_MICROS = 1_000_000n;

export const ZERO: Micros = 0n as Micros;

/** Largest value representable as a JSON integer without precision loss. */
const MAX_WIRE_MICROS = BigInt(Number.MAX_SAFE_INTEGER);

export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

/** Construct `Micros` from a bigint. Rejects negatives — money owed is a
 *  separate concept from a negative amount, and conflating them hides bugs. */
export function micros(value: bigint): Micros {
  if (value < 0n) {
    throw new MoneyError(`micros must be non-negative, got ${value}`);
  }
  return value as Micros;
}

/** Construct `Micros` from whole US dollars. Convenience for tests and seeds. */
export function usd(dollars: bigint): Micros {
  return micros(dollars * USD_MICROS);
}

// ─────────────── Wire codecs (the only number↔money boundary) ───────────────

/**
 * Decode a JSON integer into `Micros`.
 *
 * Rejects non-integers outright rather than truncating: a float arriving here
 * means an upstream layer did float arithmetic on money, and silently flooring
 * it would launder the bug into the ledger.
 */
export function microsFromWire(value: number): Micros {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`money crossed the wire as a non-integer (${value}); micros are integers`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`money exceeds safe integer range: ${value}`);
  }
  return micros(BigInt(value));
}

/** Encode `Micros` as a JSON integer. */
export function microsToWire(value: Micros): number {
  if (value > MAX_WIRE_MICROS) {
    throw new MoneyError(
      `${value} micros exceeds Number.MAX_SAFE_INTEGER and cannot be JSON-encoded`,
    );
  }
  // check-money-allow: the sanctioned bigint→JSON boundary
  return Number(value);
}

/**
 * Decode Postgres `numeric` into `Micros`, truncating toward zero.
 *
 * Postgres returns `numeric` as a decimal string. Aggregates that divide — a
 * package's weighted share of a fingerprint's revenue, say — are genuinely
 * fractional, and the fractional part has to go somewhere. Parsing the integer
 * portion of the string is exact; routing it through `Number` would put a
 * float on the money path to lose precision in.
 *
 * Truncation (never rounding up) means a displayed share can be at most one
 * micro low, never high — the same direction as every other rounding decision
 * here: never overstate what someone is owed.
 */
export function microsFromDecimalString(value: string | null | undefined): Micros {
  if (value === null || value === undefined) return ZERO;

  const trimmed = value.trim();
  if (trimmed.length === 0) return ZERO;
  // a negative share is not representable
  if (trimmed.startsWith("-")) return ZERO;

  const separator = trimmed.indexOf(".");
  const integerPart = separator === -1 ? trimmed : trimmed.slice(0, separator);
  if (!/^\d+$/u.test(integerPart)) {
    throw new MoneyError(`cannot decode "${value}" as micros`);
  }
  return micros(BigInt(integerPart));
}

// ─────────────── Arithmetic ───────────────

export function addMicros(...values: readonly Micros[]): Micros {
  let total = 0n;
  for (const value of values) total += value;
  return total as Micros;
}

export function subMicros(a: Micros, b: Micros): Micros {
  if (b > a) {
    throw new MoneyError(`subtraction would go negative: ${a} - ${b}`);
  }
  return (a - b) as Micros;
}

/** Multiply money by a dimensionless count (e.g. bid × impressions). */
export function scaleMicros(value: Micros, count: bigint): Micros {
  if (count < 0n) throw new MoneyError(`count must be non-negative, got ${count}`);
  return (value * count) as Micros;
}

export function sumMicros(values: Iterable<Micros>): Micros {
  let total = 0n;
  for (const value of values) total += value;
  return total as Micros;
}

// ─────────────── Display ───────────────

const GROUPER = new Intl.NumberFormat("en-US");

/**
 * Format for humans. Display only — never parse this back.
 *
 * Sub-cent amounts are real here: a long-tail package can earn $0.0004 in a
 * period, and rendering that as "$0.00" on a public package page would be a
 * misrepresentation. Below a cent, precision extends to the full micro.
 */
export function formatUsd(value: Micros): string {
  // The sign is stripped first and reapplied last.
  //
  // Without this, a negative value took the non-sub-cent branch (its `whole` is 0 and the
  // guard required `value > 0n`), and `(-10000n / 10_000n).toString().padStart(2, "0")`
  // produced `"-1"` — rendering -$0.01 as "$0.-1". Found by `bun run auction rebuild`
  // printing a spend delta. Negative amounts are legitimate wherever a difference or a
  // correction is displayed, so the fix belongs here rather than at each call site.
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const sign = negative ? "-" : "";

  const whole = magnitude / USD_MICROS;
  const fraction = magnitude % USD_MICROS;

  // Sub-cent amounts are real: a long-tail package can earn $0.0004 in a period, and
  // rendering that as "$0.00" on a public package page would be a misrepresentation.
  if (magnitude > 0n && whole === 0n && fraction < 10_000n) {
    const digits = fraction.toString().padStart(6, "0").replace(/0+$/u, "");
    return `${sign}$0.${digits}`;
  }

  const cents = (fraction / 10_000n).toString().padStart(2, "0");
  return `${sign}$${GROUPER.format(whole)}.${cents}`;
}
