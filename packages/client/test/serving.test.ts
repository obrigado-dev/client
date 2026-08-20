import { describe, expect, test } from "bun:test";

import { describeServing } from "../src/commands/status.ts";

/**
 * `doctor` reported "reachable" while the server was refusing to serve, and the only
 * symptom was a status line that had quietly stopped appearing. These pin the distinction
 * that was missing: reaching a server and being served by it are different facts.
 */
describe("what /health is actually saying", () => {
  test("serving is serving", () => {
    expect(describeServing({ ok: true, serving: true })).toBe("yes");
  });

  test("not serving carries the reason, because that is what ends the search", () => {
    expect(
      describeServing({
        ok: true,
        serving: false,
        reason: "killswitch unreadable: Max lifetime timeout reached after 30m",
      }),
    ).toBe("NO — killswitch unreadable: Max lifetime timeout reached after 30m");
  });

  test("not serving without a reason still says so plainly", () => {
    expect(describeServing({ ok: true, serving: false })).toBe("NO — no reason reported");
    expect(describeServing({ ok: true, serving: false, reason: "   " })).toBe(
      "NO — no reason reported",
    );
  });

  test("a missing `serving` is not treated as serving", () => {
    // The dangerous default. An older server, or a payload we failed to parse, must not
    // read as healthy — that is exactly the false negative this whole helper exists for.
    expect(describeServing({ ok: true })).toBe("NO — no reason reported");
  });

  test("a body that is not an object says so rather than guessing", () => {
    expect(describeServing(null)).toBe("unknown — no health payload");
    expect(describeServing("ok")).toBe("unknown — no health payload");
  });
});
