import { collectSignals, hostVersionFromPayload, startSession, timingFromPayload } from "../api.ts";
import { enqueue, flushQueue } from "../beacon.ts";
import { cacheFromResponse, isExhausted, isExpired, nextCreative } from "@obrigado/shared/rotation";
import type { CachedBatch } from "@obrigado/shared/rotation";
import { readStdinPayload, runChained } from "../chain.ts";
import { claudeIntegration, readConfig } from "../config.ts";
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

/** Fetch a fresh batch when the cache is cold or expired. */
async function ensureBatch(
  config: ClientConfig,
  origin: string,
  payload: string,
  cached: CachedBatch | null,
  agent: Agent,
): Promise<CachedBatch | null> {
  // Exhausted counts as stale: a batch whose every creative has been reported
  // renders for free from then on.
  if (cached !== null && !isExpired(cached) && !isExhausted(cached)) return cached;

  const { deps } = await resolveDeps();
  const response = await startSession({
    apiOrigin: origin,
    installKey: config.install_key,
    deps,
    privateRepo: await isPrivateRepo(),
    signals: collectSignals({
      agent,
      agentVersion: hostVersionFromPayload(payload),
    }),
  });
  return response === null ? null : cacheFromResponse(response);
}

/**
 * Called by Claude Code on every status-line render.
 *
 * Must be fast and must never throw: anything on stderr or a non-zero exit
 * shows up in the developer's terminal. Every failure mode degrades to printing
 * nothing, which renders the stock status line.
 */
export async function statusline(argv: readonly string[] = []): Promise<number> {
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
  if (agent === DEFAULT_AGENT) {
    const integration = claudeIntegration(config);
    // The developer's own line goes first, and goes out even if everything below
    // fails — they should never lose their status line because our server is down.
    const chainedCommand = integration?.chained_command;
    if (chainedCommand !== undefined) {
      const chained = await runChained(chainedCommand, payload);
      if (chained !== null) process.stdout.write(`${chained}\n`);
    }
  }

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
  const batch = await ensureBatch(config, origin, payload, state.batch, agent);
  if (batch === null) return 0;

  const rotation = nextCreative(batch);
  await writeSessionState(agent, sessionId, { ...state, batch, updated_at: Date.now() });
  if (rotation === null) return 0;

  if (rotation.fresh) {
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
      impression_id: rotation.item.impression_id,
      nonce: rotation.item.nonce,
      ...(Object.keys(signals).length === 0 ? {} : { signals }),
    });
  }

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
}
