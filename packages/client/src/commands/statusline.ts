import {
  collectSignals,
  hostVersionFromPayload,
  isCiEnvironment,
  startSession,
  timingFromPayload,
} from "../api.ts";
import { sharingSettings } from "../config.ts";
import { peekRetrieval } from "../retrieval.ts";
import { enqueue, flushQueue } from "../beacon.ts";
import {
  activityMoved,
  cacheFromResponse,
  isExhausted,
  isExpired,
  nextCreative,
  retrievalDigest,
} from "@obrigado/shared/rotation";
import type { BatchItem } from "@obrigado/shared";
import type { CachedBatch } from "@obrigado/shared/rotation";
import { isChainedRender, readStdinPayload, runChained } from "../chain.ts";
import { claudeIntegration, readConfig, sponsoredPosition } from "../config.ts";
import type { ClientConfig } from "../config.ts";
import { isPrivateRepo, resolveDeps } from "../deps.ts";
import { stripControlCharacters } from "../link.ts";
import { copyParts, renderCopy } from "../render.ts";
import { drainRetrieval } from "../retrieval.ts";
import {
  agentSessionLive,
  isEditorAgent,
  pruneSessionState,
  readSessionState,
  sessionIdFromPayload,
  writeSessionState,
} from "../session-state.ts";
import type { AgentSessionState } from "../session-state.ts";
import { DEFAULT_AGENT, isAgent } from "../version.ts";
import type { Agent } from "../version.ts";
import { apiOrigin } from "./shared.ts";

/** §3: "always labeled". This prefix is not configurable. */
const SPONSOR_LABEL = "sponsored";

/**
 * Which host is rendering this line.
 *
 * Passed by the installer rather than sniffed, because install is when it is a
 * fact. Claude Code is the default so the flagless command every existing
 * install already carries keeps meaning what it meant.
 *
 * It is not cosmetic: it namespaces session state, so two hosts running side by
 * side on one install key cannot consume each other's batch or nonces, and it
 * rides the impression so revenue attributes to the host that actually showed
 * the line.
 */
export function agentFromArgv(argv: readonly string[]): Agent {
  const equals = argv.find((value) => value.startsWith("--agent="));
  const index = argv.indexOf("--agent");
  const value = equals?.slice("--agent=".length) ?? (index >= 0 ? argv[index + 1] : undefined);
  return isAgent(value) ? value : DEFAULT_AGENT;
}

/**
 * How long a failed session request keeps the render from trying again.
 *
 * Without this every repaint re-parsed the lockfiles and waited on the network — up to four
 * seconds each — for as long as the server was down. A minute is long enough that an outage
 * costs one request per session per minute, short enough that recovery is felt promptly.
 */
const RETRY_AFTER_MS = 60_000;

interface BatchOutcome {
  readonly batch: CachedBatch | null;
  /** Set when there is no batch and the next render should not ask before this instant. */
  readonly retryAfter?: number | undefined;
}

/** Fetch a fresh batch when the cache is cold or expired. */
async function ensureBatch(
  config: ClientConfig,
  origin: string,
  payload: string,
  state: AgentSessionState,
  agent: Agent,
): Promise<BatchOutcome> {
  const cached = state.batch;
  // Peeked, never drained: the beacon still consumes this queue to weight the payout, and
  // taking it here would leave that empty.
  const retrieved = config.sharing?.activity === true ? await peekRetrieval() : undefined;
  const retrieval = retrievalDigest(retrieved);

  // Three reasons to refetch, and the third is what makes activity targeting mean anything.
  // Expired is age; exhausted is a batch whose every creative has been reported, which would
  // otherwise render paid inventory for free; moved is the agent having started reading
  // something else since this batch was chosen for what it was reading before.
  if (
    cached !== null &&
    !isExpired(cached) &&
    !isExhausted(cached) &&
    !activityMoved(cached, retrieval)
  ) {
    return { batch: cached };
  }

  const now = Date.now();
  if (state.retry_after !== undefined && now < state.retry_after) {
    return { batch: null, retryAfter: state.retry_after };
  }

  const { deps } = await resolveDeps();
  const response = await startSession({
    apiOrigin: origin,
    installKey: config.install_key,
    deps,
    privateRepo: await isPrivateRepo(),
    signals: collectSignals({
      agent,
      agentVersion: hostVersionFromPayload(payload),
      sharing: sharingSettings(config),
      ...(retrieved === undefined ? {} : { retrieved }),
    }),
  });
  return response === null
    ? { batch: null, retryAfter: now + RETRY_AFTER_MS }
    : { batch: cacheFromResponse(response, now, retrieval) };
}

/**
 * Persist what this render decided.
 *
 * `last_render_at` is what the editor liveness gate reads, and this is the one place it is
 * set: a render by an agent host, whether or not a line came out of it. `retry_after` is
 * carried while a failed fetch is being backed off and cleared the moment one succeeds.
 */
async function persistRender(
  agent: Agent,
  sessionId: string,
  state: AgentSessionState,
  outcome: BatchOutcome,
): Promise<void> {
  const now = Date.now();
  const next: AgentSessionState = {
    ...state,
    batch: outcome.batch,
    last_render_at: now,
    updated_at: now,
  };
  if (outcome.retryAfter === undefined) delete next.retry_after;
  else next.retry_after = outcome.retryAfter;
  await writeSessionState(agent, sessionId, next);
}

/**
 * Called by Claude Code on every status-line render.
 *
 * Must be fast and must never throw: anything on stderr or a non-zero exit
 * shows up in the developer's terminal. Every failure mode degrades to printing
 * nothing, which renders the stock status line.
 */
/**
 * A line held back until someone asks for it, and printed at most once.
 *
 * The "at most once" is the whole point: both the ordering branch and the `finally` call this,
 * and only one of them may actually write. Returning a closure rather than juggling a mutable
 * flag at two call sites keeps that invariant in one place.
 */
function pendingLine(text: string | null): () => void {
  let pending = text;
  return () => {
    if (pending === null) return;
    process.stdout.write(`${pending}\n`);
    pending = null;
  };
}

/** Queue the impression for a creative that has just taken the surface. */
async function reportImpression(item: BatchItem, payload: string): Promise<void> {
  // §14 Phase 3: timing travels with the impression, not the session, because
  // interactivity accumulates as the session runs. The first render of a session has
  // almost no history and would classify as unattended on its own; the tenth has
  // enough. Classification happens server-side at ingest from whatever this carries.
  const timing = timingFromPayload(payload);
  // §14 Phase 6. Drained rather than read: the queue is per-session state written by a
  // hook, and leaving entries behind would report the same reads against every subsequent
  // impression, inflating the multiplier for whatever the agent happened to open once.
  const retrieved = await drainRetrieval();

  const signals: { timing?: typeof timing; retrieved?: string[] } = {};
  if (Object.keys(timing).length > 0) signals.timing = timing;
  if (retrieved.length > 0) signals.retrieved = retrieved;

  await enqueue({
    type: "impression",
    impression_id: item.impression_id,
    nonce: item.nonce,
    ...(Object.keys(signals).length === 0 ? {} : { signals }),
  });
}

export async function statusline(argv: readonly string[] = []): Promise<number> {
  /*
   * A nested render prints nothing.
   *
   * Reached when the developer's own status line invokes us — directly, or through a launcher
   * configured elsewhere to call us as its inner command. The outer process is already printing
   * our line, so anything printed here is a duplicate row and, worse, a second impression
   * reported for one line that was seen once.
   */
  if (isChainedRender()) return 0;

  /*
   * A build is not an audience.
   *
   * §7: "don't serve, don't count, don't bill, don't accrue." The server refuses a session
   * that says `ci: true` and the classifier would never bill one, but the cheapest place to
   * honour the first rule is here, before a lockfile is parsed or a request leaves the runner.
   * The developer's own chained line still prints — see `finally` below — because their
   * tooling is not what is being withheld.
   */
  if (isCiEnvironment()) return 0;

  const config = await readConfig();
  if (config === null) return 0;

  const agent = agentFromArgv(argv);
  // Hosts that draw their own UI ask for the parts rather than a rendered line.
  const structured = argv.includes("--json");

  // Read once: the payload is forwarded verbatim to a chained command, which
  // must see exactly what Claude Code would have sent it.
  const payload = await readStdinPayload();
  const sessionId = sessionIdFromPayload(payload);

  // Chaining is Claude Code's, because the thing being preserved is Claude
  // Code's `statusLine` — the one slot we displaced. Other hosts append their
  // own item beside their built-ins, so there is nothing of the developer's to
  // hand back, and running their Claude command under a different host would
  // feed it a payload it was never written for.
  const chainedCommand =
    agent === DEFAULT_AGENT ? claudeIntegration(config)?.chained_command : undefined;
  const chained = chainedCommand === undefined ? null : await runChained(chainedCommand, payload);
  const emitChained = pendingLine(chained);

  /*
   * Below is the default, and below is also the easy case: their line is on screen before we
   * do anything that can fail, so every `return` past this point is free to give up.
   *
   * Above is the one that needs care. Their line is still in hand, so the guarantee it used to
   * get from being printed first has to come from somewhere else — the `finally` at the end of
   * this function, which runs on every exit including a throw. A developer must never lose
   * their status line because our server was down, whichever row they asked us to take.
   */
  if (sponsoredPosition(config) === "below") emitChained();

  try {
    // An editor surface is a COMPANION to a running agent, not independent inventory (A21).
    // The gate lives here rather than in each extension so one rule governs every editor
    // host, and so an extension cannot opt itself into billing by forgetting to ask.
    //
    // Rendering nothing rather than rendering-without-billing is deliberate: a line shown to
    // someone with no agent running is an impression an advertiser did not buy, whether or
    // not it is counted.
    if (isEditorAgent(agent) && !(await agentSessionLive())) return 0;

    const origin = apiOrigin(config);

    const state = await readSessionState(agent, sessionId);
    // A cold read means this is the session's first render. Remember it now,
    // because the write below makes every later render look identical — and it is
    // the one moment per session cheap enough to sweep abandoned state on.
    const coldStart = state.batch === null;
    const outcome = await ensureBatch(config, origin, payload, state, agent);
    const rotation = outcome.batch === null ? null : nextCreative(outcome.batch);

    /*
     * Enqueue BEFORE persisting the rotation.
     *
     * `nextCreative` has marked this nonce reported in the cached batch. Persist that first
     * and anything that fails between the write and the enqueue — a full disk, the host's
     * kill timer — leaves an impression that is locally "reported" and never queued: lost,
     * with no trace. The other order has a strictly better failure mode, because INVARIANT 5
     * makes re-queuing an impression that already landed harmless.
     */
    if (rotation?.fresh === true) await reportImpression(rotation.item, payload);

    await persistRender(agent, sessionId, state, outcome);
    if (rotation === null) return 0;

    if (structured) {
      // A host that draws its own UI cannot use an ANSI string. OpenCode's TUI has a
      // real link element, so handing it pre-escaped bytes would force it to either
      // render them literally or strip them — the two failures that disqualified
      // Codex. It gets the parts instead and composes them with its own primitives.
      //
      // This is a second SERIALISATION, not a second delivery path: rotation, batching,
      // beaconing, dwell and the disclosure above are the same code either way, and the
      // label travels with it so no host has to remember to add one.
      process.stdout.write(
        `${JSON.stringify({
          label: SPONSOR_LABEL,
          // Plain copy travels too: it is the accessible fallback for a host that cannot
          // style, and the form that belongs in a log.
          copy: stripControlCharacters(rotation.item.body).trim(),
          url: rotation.item.click_url,
          ...copyParts(rotation.item),
        })}\n`,
      );
    } else {
      // The label is outside the link, so what is clickable is the ad copy and the
      // word "sponsored" is not — a developer should never Cmd+click the disclosure
      // itself and land on an advertiser.
      // Sanitise BEFORE wrapping: escape bytes inside the link text would still
      // reach the terminal, and could erase the label that precedes it.
      // §3: the LABEL is never styled. Only the copy carries the advertiser's
      // palette choice, so the disclosure cannot be made quieter than the ad.
      const body = renderCopy(rotation.item, { color: config.color ?? "auto" });
      process.stdout.write(`${SPONSOR_LABEL} · ${body}\n`);
    }

    // Ship beacons AFTER the line is on screen, and AWAIT it.
    //
    // This was previously fire-and-forget — `void flushQueue(...)` followed by
    // `process.exit()`, which killed the process before the fetch could resolve.
    // Beacons sat in the queue with `attempts: 0` forever: not retried, because a
    // retry only records itself when an attempt FAILS, and no attempt ever
    // completed. The observable effect was that the client never reported a single
    // impression, so nothing was ever billed.
    //
    // Awaiting costs no perceived latency because the status line has already been
    // written; only process teardown waits. The alternative — flushing before the
    // render — would put a network round trip in front of every repaint.
    await flushQueue({ apiOrigin: origin, installKey: config.install_key });

    // Session state is one small file per host per session and nothing else
    // deletes it, so without a sweep it grows for the life of the install. This
    // used to ride the Codex Stop hook; when that surface was withdrawn the sweep
    // went with it, and the only symptom would have been a slowly filling
    // directory nobody looks at. Here it costs one readdir per session, after the
    // line is already on screen.
    if (coldStart) await pruneSessionState();
    return 0;
  } finally {
    // A no-op when it has already gone out. This is what makes "above" safe: their line is
    // emitted whether we returned early, finished, or threw.
    emitChained();
  }
}
