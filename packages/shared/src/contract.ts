/**
 * The wire contract (§12). One zod definition per payload, imported by both
 * ends, so the server's idea of a request and the client's idea of a request
 * are the same object rather than two hand-written types that agree today.
 *
 * `packages/shared` may not import from `server` or `client`
 * (`scripts/check-boundaries.ts` enforces it), which is what keeps this a
 * contract instead of a shared utility bucket.
 */
import { z } from "zod";

import { parseMarkup } from "./markup.ts";

export const API_VERSION = "v1";

/**
 * How long one creative holds the status line, and how long a batch is good for.
 *
 * These two live together because they are one system with `BATCH_SIZE`, and
 * splitting them across packages is how they silently stopped agreeing: a
 * 12-creative batch rotating every 30 seconds is exhausted after 360 seconds,
 * while its TTL ran for 900. For 540 seconds of every 900 the client displayed
 * ads and recorded nothing — a 60% under-count that no test caught because each
 * constant was individually reasonable.
 *
 * The server sizes a batch from these, so a batch nominally covers its own TTL.
 */
export const ROTATION_SECONDS = 30;
export const BATCH_TTL_SECONDS = 900;

/** Creatives per batch — enough to cover the TTL at the rotation period. */
export const BATCH_SIZE = Math.ceil(BATCH_TTL_SECONDS / ROTATION_SECONDS);

/** Continuous, focused browser exposure required before a website impression is confirmed. */
export const WEBSITE_VIEWABLE_MS = 1_000;

/** Header carrying the opaque install key. INVARIANT 7: the server stores only
 *  its sha256, never this value. */
export const INSTALL_KEY_HEADER = "X-Obrigado-Key";

/**
 * Money on the wire is a JSON integer of micros.
 *
 * INVARIANT 1 extends to JSON: `z.int()` rejects a float outright rather than
 * coercing it, so a float produced anywhere upstream fails at the boundary
 * instead of being rounded into the ledger. Decode with `microsFromWire`.
 */
export const WireMicros = z.int().nonnegative();

/**
 * A namespaced package identifier: `${ecosystem}:${name}`.
 *
 * Control characters are rejected here as well as in canonicalisation. Step 5
 * of §10.3 joins entries with "\n", so an identifier containing the delimiter
 * would make two different dependency sets hash identically — see
 * `packages/server/src/fingerprint.ts`. This is the outer of the two layers.
 */
export const PackageId = z
  .string()
  .min(1)
  .max(512)
  .refine((id) => !/\p{Cc}/u.test(id), {
    message: "package identifier must not contain control characters",
  });

export const DepEntry = z.object({
  /** `${ecosystem}:${name}`, e.g. `npm:react`. */
  p: PackageId,
  /** Depth in the dependency tree; 0 is a direct dependency. */
  d: z.int().min(0).max(64),
});
export type DepEntry = z.infer<typeof DepEntry>;

/**
 * Client-reported environment signals.
 *
 * Phase 0 records these without acting on them; Phase 3 classifies with them.
 * INVARIANT 3 means the column already exists, so turning this on later changes
 * no schema and no queries. Every field is optional because a client that
 * cannot determine a signal must be able to say so — an absent signal and a
 * false signal are different facts, and §7 requires erring toward not billing.
 */
export const SessionSignals = z.object({
  ci: z.boolean().optional(),
  tty: z.boolean().optional(),
  display: z.boolean().optional(),
  docker: z.boolean().optional(),
  /**
   * A container hint from cgroup inspection, separate from `/.dockerenv` (§14 Phase 3).
   *
   * Two signals rather than one because they fail differently: `/.dockerenv` is absent
   * under Podman, containerd and most Kubernetes runtimes, while cgroup paths are
   * readable in all of them and absent on macOS. Neither alone covers the ground.
   */
  container: z.boolean().optional(),
  /**
   * Which host the line renders in — `claude-code`, `codex`, and so on.
   *
   * Recorded at INSTALL time rather than guessed at runtime, because it is a fact about
   * where the client was installed rather than something to sniff from the environment. It
   * was a hardcoded `"claude-code"` until the second host was on the horizon, at which
   * point the field would simply have lied.
   *
   * REQUIRED, because every impression is billed to a host and an impression that cannot
   * name its host cannot be attributed. Optional was only ever tenable while there was one
   * host to assume; with more than one, a missing value is not a small gap in a report, it
   * is revenue credited to whichever agent the reader guesses.
   */
  agent: z.string().max(64),
  /** The HOST's version, as the host reports it. Not ours. */
  agent_version: z.string().max(64).optional(),
  /**
   * OUR client's version — the thing that has to be answerable once the backend deploys
   * separately from the extensions.
   *
   * Without it there is no way to ask "what is actually out there", to scope an incident to
   * a release, or to know when a contract change is safe. The beacon-queue outage was
   * invisible on one machine; across a population, with no version on the wire, it would
   * have shown up as revenue quietly falling with nothing to correlate it against.
   */
  client_version: z.string().max(32).optional(),
  os: z.string().max(64).optional(),
});
export type SessionSignals = z.infer<typeof SessionSignals>;

/**
 * Session timing, reported per beacon (§14 Phase 3: "interactivity (post-start human
 * input), inter-turn timing").
 *
 * ## What these are
 *
 * The host tells a status line how long the session has run and how much of that was
 * spent waiting on the API. The difference is time the agent was NOT working —
 * overwhelmingly a human reading output and typing. The documented example is 45s
 * total against 2.3s of API time: 95% of that session was a person.
 *
 * An unattended run has no such gap. A scripted or CI session moves straight from one
 * API response to the next request, so total and API time converge.
 *
 * ## What is deliberately not here
 *
 * The same payload carries `session_id`, `transcript_path`, `cwd`, `workspace`,
 * `model`, and `cost.total_cost_usd`. None of it is sent. A conversation transcript
 * path and a working directory identify a person and a repository; what a developer
 * spends on their own agent is not Obrigado's business; and §10.4 already treats a
 * dependency set as sensitive, so adding a path alongside it would be worse.
 *
 * Only two durations leave the machine, and both are rounded to whole seconds — the
 * classifier needs a ratio, not a stopwatch, and a millisecond-precise session length
 * is a much better join key than a coarse one.
 */
/**
 * The outer bound on a reported duration: 30 days.
 *
 * It was 24 hours, and 24 hours is wrong. An agent session is not a working day — one left
 * open across a weekend, or a long-running task, passes a day of wall clock easily, and a
 * real session on this very repository did. The bound exists to reject implausible or forged
 * values, not legitimate ones.
 *
 * The cost of getting it too tight was not a rejected signal, which would have been fine. The
 * beacon validates the whole request, so ONE out-of-range event 400s the entire batch, and
 * the client kept retrying it — poisoning the queue and blocking every later impression
 * behind it. Twenty-five events had accumulated, one had been retried 185 times, and not a
 * single impression had been billed since.
 */
export const MAX_DURATION_S = 30 * 24 * 60 * 60;

export const TimingSignals = z.object({
  /** Whole seconds of wall clock since the session started. */
  session_s: z.int().min(0).max(MAX_DURATION_S).optional(),
  /** Whole seconds of it spent waiting on the API. */
  api_s: z.int().min(0).max(MAX_DURATION_S).optional(),
});
export type TimingSignals = z.infer<typeof TimingSignals>;

/**
 * The styling an advertiser may request.
 *
 * An enum, not a colour: free-form styling is how ad copy impersonates system
 * output. Red and yellow are absent deliberately — in a terminal they mean
 * error and warning, so an ad wearing them is faking a build failure. Bold,
 * reverse, blink and backgrounds are absent because they would make the copy
 * louder than the `sponsored` label that discloses it (§3).
 *
 * The client maps these to the basic 8 ANSI slots, which the developer's own
 * terminal theme remaps — so "cyan" means whatever their cyan is.
 */
export const CreativeStyle = z.enum(["default", "cyan", "blue", "green", "magenta"]);
export type CreativeStyle = z.infer<typeof CreativeStyle>;

/**
 * A text effect, distinct from colour.
 *
 * Italic is allowed and bold is not, and the line between them is §3's rather
 * than a matter of taste: italic DIFFERENTIATES the sponsored line from the
 * developer's own status text, which helps the disclosure do its job. Bold
 * AMPLIFIES the copy, making it louder than the `sponsored` label that discloses
 * it. Reverse, blink and backgrounds are excluded for the same reason as bold.
 */
export const CreativeEffect = z.enum(["none", "italic"]);
export type CreativeEffect = z.infer<typeof CreativeEffect>;

// ─────────────── POST /api/v1/session ───────────────

export const SessionRequest = z.object({
  deps: z.array(DepEntry).max(20_000),
  private_repo: z.boolean().default(false),
  // Required, not defaulted. Signals carry the host, and a session that will not
  // say which agent it is cannot have its impressions attributed to one.
  signals: SessionSignals,
});
export type SessionRequest = z.infer<typeof SessionRequest>;

/**
 * A styled run of text, as the client receives it.
 *
 * The client renders spans and never parses markup: authoring syntax is parsed
 * and validated once, server-side, so untrusted markup never reaches a terminal
 * renderer. `link` marks part of the single tracking link, whose URL is
 * `click_url` — an advertiser never supplies per-span URLs.
 */
export const WireSpan = z.object({
  text: z.string().max(160),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  highlight: z.boolean().optional(),
  color: z.enum(["cyan", "blue", "green", "magenta"]).optional(),
  link: z.boolean().optional(),
});
export type WireSpan = z.infer<typeof WireSpan>;

/**
 * Who is paying for the line.
 *
 * `name` is the advertiser's own name, not inferred. The OpenCode wordmark used to read the
 * trailing domain out of the copy because there was nothing else to read, which is the kind
 * of inference that eventually renders the wrong company's name in somebody's editor.
 *
 * `logo` is a `data:image/png;base64,…` URI built server-side from validated bytes — never an
 * http(s) URL. A remote URL would make every render fetch the advertiser's origin from inside
 * a developer's editor, handing them an IP address and an activity signal they did not buy.
 * Surfaces that cannot show an image ignore this; nothing depends on it rendering.
 */
export const BatchBrand = z.object({
  name: z.string().min(1).max(40),
  logo: z.string().startsWith("data:image/png;base64,").max(6000).nullable().default(null),
});
export type BatchBrand = z.infer<typeof BatchBrand>;

export const BatchItem = z.object({
  impression_id: z.uuid(),
  /** Base64. An impression counts only if the beacon returns this value. */
  nonce: z.base64(),
  /** Visible text, markup removed — the accessible fallback and log form. */
  body: z.string().max(160),
  click_url: z.url(),
  style: CreativeStyle.default("default"),
  effect: CreativeEffect.default("none"),
  /** Per-run styling. Empty means render `body` plainly. */
  spans: z.array(WireSpan).max(48).default([]),
  /** Nullable so a renderer never has to assume one exists; the server always sends it. */
  brand: BatchBrand.nullable().default(null),
  rev_micros: WireMicros,
});
export type BatchItem = z.infer<typeof BatchItem>;

export const SessionResponse = z.object({
  /** Computed server-side from `deps`. INVARIANT 8: a client-supplied
   *  fingerprint is never read. */
  fp: z.string().length(32),
  batch: z.array(BatchItem),
  ttl_seconds: z.int().positive(),
  /** INVARIANT 6: false when the killswitch is engaged. The client renders
   *  nothing at all in that case. */
  serving: z.boolean(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

// ─────────────── POST /api/v1/beacon ───────────────

export const BeaconEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("impression"),
    impression_id: z.uuid(),
    nonce: z.base64(),
    dwell_ms: z.int().min(0).max(86_400_000).optional(),
    signals: z
      .object({
        focused: z.boolean().optional(),
        /** A later, explicit human action confirming an ephemeral hook surface. */
        interaction: z.enum(["user_prompt"]).optional(),
        /** Session timing at the moment this impression was shown (§14 Phase 3). */
        timing: TimingSignals.optional(),
        /**
         * Packages the agent actually read (§14 Phase 6).
         *
         * Package ids only — never a path. The client resolves a path to a package locally,
         * because a path inside a private repository is more identifying than the dependency
         * set §10.4 already treats as sensitive.
         */
        retrieved: z.array(z.string().max(200)).max(500).optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("click"),
    impression_id: z.uuid(),
    nonce: z.base64(),
  }),
]);
export type BeaconEvent = z.infer<typeof BeaconEvent>;

export const BeaconRequest = z.object({
  events: z.array(BeaconEvent).max(500),
});
export type BeaconRequest = z.infer<typeof BeaconRequest>;

export const BeaconResponse = z.object({
  accepted: z.int().min(0),
  /** Unknown, already-consumed, or expired nonces. Reported rather than
   *  silently dropped so a client bug is visible instead of looking like low
   *  engagement. */
  rejected: z.int().min(0),
});
export type BeaconResponse = z.infer<typeof BeaconResponse>;

// ─────────────── Advertiser ───────────────

export const TargetingRule = z.object({
  rule_type: z.enum(["package", "ecosystem"]),
  rule_value: z.string().min(1).max(512),
});
export type TargetingRule = z.infer<typeof TargetingRule>;

export const CreateCampaignRequest = z.object({
  name: z.string().min(1).max(120),
  bid_micros: WireMicros.positive(),
  total_budget_micros: WireMicros.positive(),
  daily_budget_micros: WireMicros.positive().optional(),
  /** Empty = match all (§11). */
  targeting: z.array(TargetingRule).max(1000).default([]),
});
export type CreateCampaignRequest = z.infer<typeof CreateCampaignRequest>;

/**
 * Creative copy, as an advertiser submits it.
 *
 * Control characters are REJECTED, not stripped. This is the control that keeps
 * §3's "always labeled" true: the client writes this text to a terminal, and
 * `ESC [ 2K` erases the line while `ESC [ 1G` returns the cursor to column one.
 * A body containing those two sequences deletes the `sponsored` label that
 * precedes it and can then render whatever it likes — a red fake build error
 * telling the developer to pipe a script into a shell, say. The disclosure has
 * to be un-erasable by the thing it discloses.
 *
 * Rejected rather than sanitised because an advertiser submitting escape bytes
 * is either attacking the surface or has a broken pipeline, and silently
 * cleaning it up hides which. The renderer sanitises as well (defence in depth),
 * and the database has a CHECK, so this cannot be bypassed by reaching a
 * different layer.
 */
/**
 * Creative copy as authored, including inline markup.
 *
 * Length is checked on VISIBLE characters by the markup validator, not on the
 * raw string: markers are authoring overhead and should not eat into the
 * status-line budget. See `markup.ts` for the syntax, and for why emphasis is
 * capped as a proportion rather than banned.
 */
export const AuthoredBody = z
  .string()
  .min(1)
  .max(400)
  .refine((body) => !/\p{Cc}/u.test(body), {
    message:
      "creative copy must not contain control characters — they can erase the sponsored label",
  })
  .superRefine((body, ctx) => {
    const { problems, plain } = parseMarkup(body);
    for (const problem of problems) {
      ctx.addIssue({ code: "custom", message: problem });
    }
    if (plain.trim().length === 0) {
      ctx.addIssue({ code: "custom", message: "copy is empty once markup is removed" });
    }
  });

/**
 * Changing a live campaign (§12 `PATCH /api/v1/advertiser/campaigns/:id`).
 *
 * Every field optional: a PATCH that must restate the budget to change the bid
 * invites an advertiser to overwrite one with a stale value.
 *
 * `status` deliberately omits 'exhausted' and 'draft'. Exhaustion is a fact the
 * serving path derives from spend, not a state an advertiser asserts, and
 * letting one claim it would make budget enforcement advisory.
 */
export const UpdateCampaignRequest = z.object({
  status: z.enum(["active", "paused", "ended"]).optional(),
  bid_micros: WireMicros.positive().optional(),
  total_budget_micros: WireMicros.positive().optional(),
  daily_budget_micros: WireMicros.positive().optional(),
  /**
   * Replaces the whole rule set when present; leaves it alone when absent.
   *
   * Replace-all rather than add/remove because the editing surface is a list the
   * advertiser sees in full — and because "absent means unchanged, empty means
   * match everything" is a distinction that has to survive: an empty rule set is
   * a deliberate, high-consequence choice (serve to every dependency tree), not
   * the same thing as not mentioning targeting.
   */
  targeting: z.array(TargetingRule).max(1000).optional(),
});
export type UpdateCampaignRequest = z.infer<typeof UpdateCampaignRequest>;

export const CreateCreativeRequest = z.object({
  body: AuthoredBody,
  click_url: z.url(),
  style: CreativeStyle.default("default"),
  effect: CreativeEffect.default("none"),
});
export type CreateCreativeRequest = z.infer<typeof CreateCreativeRequest>;

// ─────────────── Install-scoped reporting (§14 Phase 1) ───────────────

/**
 * One package an install has funded.
 *
 * `share_micros` is the POOL share — what the maintainer is owed — never gross.
 * Reporting gross would overstate what a developer's sessions actually sent to
 * open source by 30/70, on the surface whose entire job is being believed.
 */
export const FundedPackageWire = z.object({
  package_id: z.string(),
  share_micros: WireMicros,
  depth: z.int().min(0),
});
export type FundedPackageWire = z.infer<typeof FundedPackageWire>;

/**
 * What `obrigado status` and `obrigado projects` render.
 *
 * The four figures §14 names — "this period's contribution, top funded packages,
 * session count, lifetime total" — plus the share link state, so `status` can tell
 * a developer whether a public page for their install exists.
 */
export const StatsResponse = z.object({
  period: z.string(),
  sessions: z.int().min(0),
  period_micros: WireMicros,
  lifetime_micros: WireMicros,
  package_count: z.int().min(0),
  funded: z.array(FundedPackageWire),
  first_seen: z.string(),
  /** Absent when the install has never been shared. */
  share_url: z.string().optional(),
});
export type StatsResponse = z.infer<typeof StatsResponse>;

/**
 * Issue or revoke the share link.
 *
 * Two explicit actions rather than a toggle: "revocable" is a promise a developer
 * has to be able to keep deliberately, and a toggle whose current state the client
 * has cached wrong would revoke when they meant to reissue.
 */
export const ShareRequest = z.object({
  action: z.enum(["issue", "revoke"]),
});
export type ShareRequest = z.infer<typeof ShareRequest>;

export const ShareResponse = z.object({
  /** Absent after a revoke. */
  share_url: z.string().optional(),
  revoked: z.boolean(),
});
export type ShareResponse = z.infer<typeof ShareResponse>;

// ─────────────── Errors ───────────────

export const ApiError = z.object({
  error: z.string(),
  detail: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
