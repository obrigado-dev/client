import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import {
  addMicros,
  formatUsd,
  MoneyError,
  micros,
  microsFromWire,
  microsToWire,
  subMicros,
  usd,
} from "../src/money.ts";
import type { Micros } from "../src/money.ts";

/** Gross amounts spanning a single micro to well past the §5 upside case
 *  ($800k/month ≈ 8e11 micros). */
const anyGross = fc.bigInt({ min: 0n, max: 10n ** 15n }).map((n) => micros(n));

describe("wire codecs — the only number↔money boundary", () => {
  test("round-trips every safe integer", () => {
    fc.assert(
      fc.property(fc.nat({ max: Number.MAX_SAFE_INTEGER }), (n) => {
        expect(microsToWire(microsFromWire(n))).toBe(n);
      }),
      { numRuns: 2000 },
    );
  });

  test("rejects a float rather than truncating it", () => {
    // A float arriving here means an upstream layer did float arithmetic on
    // money. Flooring it would launder that bug into the ledger.
    expect(() => microsFromWire(3000.5)).toThrow(MoneyError);
    expect(() => microsFromWire(0.1 + 0.2)).toThrow(MoneyError);
  });

  test("rejects NaN, Infinity and unsafe integers", () => {
    expect(() => microsFromWire(Number.NaN)).toThrow(MoneyError);
    expect(() => microsFromWire(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    expect(() => microsFromWire(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
  });

  test("refuses to encode a value that JSON cannot carry losslessly", () => {
    const tooBig = micros(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(() => microsToWire(tooBig)).toThrow(MoneyError);
  });
});

describe("arithmetic", () => {
  test("addMicros is exact over large sets", () => {
    fc.assert(
      fc.property(fc.array(anyGross, { maxLength: 1000 }), (values) => {
        let expected = 0n;
        for (const v of values) expected += v;
        expect(addMicros(...values)).toBe(expected as Micros);
      }),
      { numRuns: 500 },
    );
  });

  test("negative money is rejected at construction, not represented", () => {
    expect(() => micros(-1n)).toThrow(MoneyError);
    expect(() => subMicros(micros(1n), micros(2n))).toThrow(MoneyError);
  });
});

/**
 * A negative bigint typed as `Micros`, which `micros()` correctly refuses to produce.
 *
 * Only reachable through an `as Micros` cast — a contract violation by definition. Named
 * so the tests below cannot be mistaken for an endorsement of negative money.
 */
const asIfCast = (value: bigint): Micros => value as Micros;

describe("formatUsd", () => {
  test("renders dollars and cents", () => {
    expect(formatUsd(usd(0n))).toBe("$0.00");
    expect(formatUsd(usd(47n))).toBe("$47.00");
    expect(formatUsd(micros(1_234_560_000n))).toBe("$1,234.56");
    expect(formatUsd(usd(140_000n))).toBe("$140,000.00");
  });

  test("does not render a real sub-cent amount as $0.00", () => {
    // A long-tail package earning $0.0004 in a period is a real case (§5:
    // rank ~10,000 earns under $5). Showing "$0.00" on a public package page
    // would misrepresent it.
    expect(formatUsd(micros(400n))).toBe("$0.0004");
    expect(formatUsd(micros(1n))).toBe("$0.000001");
    expect(formatUsd(micros(9_999n))).toBe("$0.009999");
    expect(formatUsd(micros(10_000n))).toBe("$0.01");
  });

  test("a negative value renders as a negative, not as garbage", () => {
    // `micros()` rejects negatives, so this input can only arrive through an `as Micros`
    // cast — which is exactly what `bun run auction rebuild` did with a spend delta,
    // printing "$0.-1". The contract violation is the caller's bug and was fixed there;
    // this is defence in depth, because a wrong NUMBER is worse than a stray minus sign.
    expect(formatUsd(asIfCast(-10_000n))).toBe("-$0.01");
    expect(formatUsd(asIfCast(-400n))).toBe("-$0.0004");
    expect(formatUsd(asIfCast(-1_234_560_000n))).toBe("-$1,234.56");
    expect(formatUsd(asIfCast(-1n))).toBe("-$0.000001");
  });

  test("micros() is what actually forbids a negative amount", () => {
    // The invariant the formatter is only backstopping.
    expect(() => micros(-1n)).toThrow(/non-negative/u);
  });

  test("never renders a nonzero amount as zero", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), (n) => {
        expect(formatUsd(micros(n))).not.toBe("$0.00");
      }),
      { numRuns: 2000 },
    );
  });
});
