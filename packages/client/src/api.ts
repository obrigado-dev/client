/**
 * Typed transport to the Obrigado API.
 *
 * Request and response shapes come from `@obrigado/shared`, the same zod
 * definitions the server validates against, so the two ends cannot drift.
 * Responses are parsed rather than cast — a server that changes shape produces
 * a clear failure here instead of `undefined` reaching the status line.
 */
import { existsSync, readFileSync } from "node:fs";

import { MAX_DURATION_S, SessionResponse, ShareResponse, StatsResponse } from "@obrigado/shared";
import type { DepEntry, SessionSignals, TimingSignals } from "@obrigado/shared";

import { CLIENT_VERSION } from "./version.ts";

const SESSION_TIMEOUT_MS = 4_000;

export interface SessionOptions {
  readonly apiOrigin: string;
  readonly installKey: string;
  readonly deps: readonly DepEntry[];
  readonly privateRepo: boolean;
  readonly signals: SessionSignals;
}

export async function startSession(options: SessionOptions): Promise<SessionResponse | null> {
  try {
    const response = await fetch(`${options.apiOrigin}/api/v1/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Obrigado-Key": options.installKey,
      },
      body: JSON.stringify({
        deps: options.deps,
        private_repo: options.privateRepo,
        signals: options.signals,
      }),
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const parsed = SessionResponse.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    // Offline, timed out, or unreachable. The status line renders nothing.
    return null;
  }
}

/**
 * This install's numbers (§14 Phase 1).
 *
 * A longer timeout than the session path: nothing is blocking a status-line render
 * here, and a developer who typed `obrigado status` is willing to wait a moment for a
 * real answer rather than get a blank one.
 */
const STATS_TIMEOUT_MS = 8_000;

export interface StatsOptions {
  readonly apiOrigin: string;
  readonly installKey: string;
}

export async function fetchStats(options: StatsOptions): Promise<StatsResponse | null> {
  try {
    // POST, not GET: the install key is a bearer credential and a GET invites it
    // into a query string, where it reaches access logs and shell history.
    const response = await fetch(`${options.apiOrigin}/api/v1/stats`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Obrigado-Key": options.installKey },
      body: "{}",
      signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const parsed = StatsResponse.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function changeShare(
  options: StatsOptions,
  action: "issue" | "revoke",
): Promise<ShareResponse | null> {
  try {
    const response = await fetch(`${options.apiOrigin}/api/v1/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Obrigado-Key": options.installKey },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const parsed = ShareResponse.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * CI environment variables, from `ci-info`'s list (§14 Phase 3).
 *
 * `CI` alone is not enough: GitHub Actions sets it, but several systems set only their
 * own variable, and a false negative here bills an advertiser for a build. Vendor
 * variables are checked alongside the generic ones for that reason.
 */
const CI_VARIABLES = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "BUILD_NUMBER",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "TRAVIS",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "TF_BUILD",
  "BITBUCKET_BUILD_NUMBER",
  "DRONE",
  "SEMAPHORE",
  "APPVEYOR",
  "CODEBUILD_BUILD_ID",
  "NETLIFY",
  "VERCEL",
  "HEROKU_TEST_RUN_ID",
] as const;

/**
 * Is this process in a container? (§14 Phase 3: `/.dockerenv`, cgroup patterns.)
 *
 * Two probes because they fail in opposite directions. `/.dockerenv` exists under
 * Docker and almost nowhere else — not Podman, not containerd, not most Kubernetes
 * runtimes. cgroup paths name the runtime in all of those, and the file does not
 * exist on macOS at all.
 *
 * Returns undefined when neither probe can run. §7 requires erring toward not billing,
 * and "the filesystem would not answer" is not "there is no container".
 */
function containerSignals(): { docker?: boolean; container?: boolean } {
  const out: { docker?: boolean; container?: boolean } = {};

  try {
    out.docker = existsSync("/.dockerenv");
  } catch {
    // Left undefined.
  }

  try {
    // Synchronous and tiny: this runs on the session path, which must not add latency
    // to a status-line render, and the file is a few hundred bytes of procfs.
    const cgroup = readFileSync("/proc/self/cgroup", "utf8");
    out.container = /docker|kubepods|containerd|podman|lxc|garden/iu.test(cgroup);
  } catch {
    // Not Linux, or procfs unavailable. Left undefined rather than false.
  }

  return out;
}

/**
 * Environment signals (§14 Phase 3).
 *
 * Absent is different from false: §7 requires erring toward not billing, so a signal
 * we cannot determine is omitted rather than guessed.
 *
 * `tty` is deliberately NOT `process.stdout.isTTY`. Claude Code captures a status
 * line's output rather than connecting it to the terminal, so stdout is a pipe on
 * every single render — reporting that as "no TTY" would classify every human
 * impression as unattended and suppress all revenue. `style.ts` already learned this
 * for colour detection; the same trap applies here with money attached.
 *
 * stderr is not captured, so it is the honest probe. `TERM` is the fallback: a real
 * terminal sets it, and CI runners typically set it to `dumb` or not at all.
 */
export interface SignalContext {
  /** Which host, from the install record. Not sniffed — see version.ts. */
  readonly agent: string;
  /** The HOST's own version, if its payload reported one. */
  readonly agentVersion?: string | undefined;
}

export function collectSignals(context: SignalContext): SessionSignals {
  const env = process.env;

  const signals: SessionSignals = {
    ci: CI_VARIABLES.some((name) => env[name] !== undefined),
    tty: process.stderr.isTTY === true || (env["TERM"] !== undefined && env["TERM"] !== "dumb"),
    display: env["DISPLAY"] !== undefined || env["WAYLAND_DISPLAY"] !== undefined,
    // Passed in rather than hardcoded. This was the literal string "claude-code" until a
    // second host was on the horizon, at which point the field would have quietly lied about
    // every Codex install — and it is the field that distinguishes them.
    agent: context.agent,
    ...(context.agentVersion === undefined ? {} : { agent_version: context.agentVersion }),
    client_version: CLIENT_VERSION,
    os: process.platform,
    ...containerSignals(),
  };

  return signals;
}

/**
 * The host's own version, from its status-line payload.
 *
 * Claude Code reports `version` alongside the session state. Read defensively: a host that
 * omits it, or sends something that is not a string, produces no signal rather than a
 * fabricated one — the same rule the timing extraction follows, for the same reason.
 */
export function hostVersionFromPayload(payload: string): string | undefined {
  if (payload.length === 0) return undefined;
  try {
    const parsed = JSON.parse(payload) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version.slice(0, 64)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Milliseconds to whole seconds, clamped to what the contract accepts.
 *
 * The clamp is the point. The client must never construct a request the server will refuse,
 * because the beacon validates the whole batch: one out-of-range value 400s every event sent
 * with it, and the queue then retries the poisoned batch forever. That is not hypothetical —
 * a session that ran past the old 24-hour bound blocked twenty-five impressions from ever
 * being billed.
 *
 * Clamping loses precision on an implausibly long session and keeps everything else flowing,
 * which is the right trade in both directions.
 */
function seconds(milliseconds: number): number {
  return Math.min(Math.floor(milliseconds / 1000), MAX_DURATION_S);
}

/**
 * Session timing from the host's status-line payload (§14 Phase 3).
 *
 * The payload also carries `session_id`, `transcript_path`, `cwd`, `workspace`,
 * `model` and `cost.total_cost_usd`. None of it is read here. A transcript path and a
 * working directory identify a person and a repository, and what a developer spends on
 * their own agent is not Obrigado's business — see the contract for the full reasoning.
 *
 * Rounded to whole seconds on the way out. The classifier needs a ratio, not a
 * stopwatch, and a millisecond-precise session length is a far better join key than a
 * coarse one.
 */
export function timingFromPayload(payload: string): TimingSignals {
  if (payload.length === 0) return {};

  try {
    const parsed = JSON.parse(payload) as { cost?: Record<string, unknown> };
    const cost = parsed.cost;
    if (cost === undefined) return {};

    const total = cost["total_duration_ms"];
    const api = cost["total_api_duration_ms"];

    const timing: TimingSignals = {};
    // `Number.isFinite` rather than a typeof check: a host that sends a string or NaN
    // must not produce a NaN ratio the classifier then compares against a threshold.
    if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
      timing.session_s = seconds(total);
    }
    if (typeof api === "number" && Number.isFinite(api) && api >= 0) {
      timing.api_s = seconds(api);
    }
    return timing;
  } catch {
    // Not JSON, or a shape we do not recognise. An absent signal is the correct
    // answer; guessing one is how a classifier starts billing for CI runs.
    return {};
  }
}
