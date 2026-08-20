/**
 * Client signal collection (§14 Phase 3).
 *
 * Two things these protect, and both have money attached.
 *
 * **The stdout trap.** Claude Code captures a status line's output rather than
 * connecting it to the terminal, so `process.stdout.isTTY` is false on every single
 * render. Reporting that as `tty: false` makes the server classify every human
 * impression `unattended` and suppresses all revenue. `style.ts` already learned this
 * for colour detection; here it would be silent and expensive.
 *
 * **The privacy boundary.** The host's payload carries `session_id`,
 * `transcript_path`, `cwd`, `workspace`, `model` and `cost.total_cost_usd`. None of it
 * may leave the machine. A transcript path and a working directory identify a person
 * and a repository, and what a developer spends on their own agent is not Obrigado's
 * business.
 */
import { describe, expect, test } from "bun:test";

import { collectSignals, timingFromPayload } from "../src/api.ts";

/** A realistic payload, from the shape the status-line docs publish. */
const PAYLOAD = JSON.stringify({
  hook_event_name: "Status",
  session_id: "abc123-secret-session",
  transcript_path: "/Users/someone/.claude/projects/private-repo/transcript.jsonl",
  cwd: "/Users/someone/Code/acme-internal",
  model: { id: "claude-opus-5", display_name: "Opus" },
  workspace: { current_dir: "/Users/someone/Code/acme-internal", project_dir: "/Users/someone" },
  version: "2.0.0",
  cost: {
    total_cost_usd: 12.34,
    total_duration_ms: 45_000,
    total_api_duration_ms: 2300,
    total_lines_added: 156,
    total_lines_removed: 23,
  },
  exceeds_200k_tokens: false,
});

describe("timing extraction", () => {
  test("reads the two durations and rounds to whole seconds", () => {
    expect(timingFromPayload(PAYLOAD)).toEqual({ session_s: 45, api_s: 2 });
  });

  test("nothing else from the payload comes out", () => {
    // The whole object is asserted, not just spot-checked: an added field would fail
    // this rather than quietly start being transmitted.
    const timing = timingFromPayload(PAYLOAD);
    expect(Object.keys(timing).toSorted()).toEqual(["api_s", "session_s"]);

    const serialised = JSON.stringify(timing);
    for (const secret of [
      "abc123-secret-session",
      "transcript",
      "acme-internal",
      "claude-opus-5",
      "12.34",
      "156",
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });

  test("the developer's spend never leaves the machine", () => {
    // Called out separately because it is the field most likely to be added by someone
    // building a "cost per impression" metric without thinking about whose cost it is.
    expect(JSON.stringify(timingFromPayload(PAYLOAD))).not.toContain("cost");
  });

  test("an empty payload yields no signals rather than zeros", () => {
    // Zeros would be a claim: a zero-length session disqualifies, so reporting them
    // would turn "the host told us nothing" into "positively not a human".
    expect(timingFromPayload("")).toEqual({});
  });

  test("malformed input yields no signals", () => {
    expect(timingFromPayload("not json at all")).toEqual({});
    expect(timingFromPayload("{}")).toEqual({});
    expect(timingFromPayload('{"cost":{}}')).toEqual({});
  });

  test("a non-numeric or non-finite duration is discarded, not coerced", () => {
    // A NaN reaching the classifier compares false against every threshold, which
    // reads as "not attended" — the safe direction, but by accident rather than by
    // rule. Discarding it makes the absence explicit.
    expect(timingFromPayload('{"cost":{"total_duration_ms":"45000"}}')).toEqual({});
    expect(timingFromPayload('{"cost":{"total_duration_ms":null}}')).toEqual({});
    expect(timingFromPayload('{"cost":{"total_duration_ms":-1}}')).toEqual({});
  });

  test("one duration present without the other is reported as-is", () => {
    // Half a signal is still a fact. The server needs both to compute a ratio and will
    // fall through to `unknown` without them, which is correct.
    expect(timingFromPayload('{"cost":{"total_duration_ms":45000}}')).toEqual({ session_s: 45 });
    expect(timingFromPayload('{"cost":{"total_api_duration_ms":2300}}')).toEqual({ api_s: 2 });
  });
});

describe("environment signals", () => {
  test("tty is not read from stdout", async () => {
    // The load-bearing assertion, and it has to look at CODE rather than at the file:
    // the doc comment above `collectSignals` names `process.stdout.isTTY` in order to
    // warn about it, and a whole-file grep flagged that as the defect. Same false
    // positive `check:money` produced against the comment explaining why not to divide
    // by a million.
    const source = await Bun.file(new URL("../src/api.ts", import.meta.url).pathname).text();

    const code = source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      })
      .join("\n");

    expect(code).not.toContain("stdout.isTTY");
    expect(code).toContain("stderr.isTTY");
  });

  test("and the harness proves why: stdout really is a pipe here", () => {
    // Exactly the condition Claude Code creates. If `collectSignals` consulted stdout
    // it would report no TTY on every render and suppress all revenue — so this asserts
    // the trap is real rather than theoretical.
    expect(process.stdout.isTTY).not.toBe(true);
  });

  test("a real terminal environment reports a tty", () => {
    const previous = process.env["TERM"];
    process.env["TERM"] = "xterm-256color";
    try {
      expect(collectSignals({ agent: "claude-code" }).tty).toBe(true);
    } finally {
      if (previous === undefined) delete process.env["TERM"];
      else process.env["TERM"] = previous;
    }
  });

  test("TERM=dumb does not report a tty when stderr is a pipe", () => {
    // CI runners commonly set TERM=dumb or leave it unset. Under the test harness
    // stderr is not a terminal, so the fallback is the only thing answering.
    const previous = process.env["TERM"];
    process.env["TERM"] = "dumb";
    try {
      expect(collectSignals({ agent: "claude-code" }).tty).toBe(process.stderr.isTTY === true);
    } finally {
      if (previous === undefined) delete process.env["TERM"];
      else process.env["TERM"] = previous;
    }
  });

  test("CI is detected from vendor variables, not just CI=1", () => {
    // A false negative here bills an advertiser for a build. Several systems set only
    // their own variable.
    const previousCi = process.env["CI"];
    delete process.env["CI"];

    const detected = ["GITHUB_ACTIONS", "BUILDKITE", "TEAMCITY_VERSION", "VERCEL"].map((name) => {
      process.env[name] = "1";
      const result = `${name}: ${collectSignals({ agent: "claude-code" }).ci}`;
      delete process.env[name];
      return result;
    });

    if (previousCi !== undefined) process.env["CI"] = previousCi;

    expect(detected).toEqual([
      "GITHUB_ACTIONS: true",
      "BUILDKITE: true",
      "TEAMCITY_VERSION: true",
      "VERCEL: true",
    ]);
  });

  test("no CI variables means ci is false", () => {
    const saved: Record<string, string | undefined> = {};
    const names = ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "BUILD_NUMBER"];
    for (const name of names) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    try {
      expect(collectSignals({ agent: "claude-code" }).ci).toBe(false);
    } finally {
      for (const name of names) {
        const value = saved[name];
        if (value !== undefined) process.env[name] = value;
      }
    }
  });

  test("the agent and platform are reported", () => {
    const signals = collectSignals({ agent: "claude-code" });
    expect(signals.agent).toBe("claude-code");
    expect(signals.os).toBe(process.platform);
  });

  test("container detection reports a boolean or nothing, never a guess", () => {
    // On macOS `/proc/self/cgroup` does not exist, so `container` must be absent rather
    // than false — §7 requires erring toward not billing, and "the filesystem would not
    // answer" is not "there is no container".
    const signals = collectSignals({ agent: "claude-code" });
    for (const key of ["docker", "container"] as const) {
      const value = signals[key];
      expect(value === undefined || typeof value === "boolean").toBe(true);
    }
    if (process.platform === "darwin") {
      expect(signals.container).toBeUndefined();
    }
  });
});
