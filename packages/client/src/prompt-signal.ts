/**
 * How long ago the person last did something, for the server's attention rule (`input_age_s`): sent
 * a prompt, in an agent's own interface, or typed or clicked in an editor's window.
 *
 * Claude Code's status-line payload names the prompt it is working on (`prompt_id`, an opaque id
 * that changes with every prompt) but not when it arrived. A render that sees a new id is the
 * first to know about that prompt, so it notes the moment, and every impression after carries
 * the age of the latest one. Renders follow new assistant messages, so a prompt is noticed within
 * seconds of being sent.
 *
 * What this reads and keeps is the least that answers the question: the id is digested before it
 * is stored and never sent, the prompt's text is never read, and only a number of seconds leaves
 * the machine. A host whose payload names no prompt reports no age, and its slots are never
 * counted attended on this evidence.
 *
 * Claude Code's id is opaque, so a prompt it started itself (a scheduled one, a `/loop` round)
 * counts as well; a background task's report carries the current id rather than a new one. Hosts
 * that can tell a typed message from any other (OpenCode, Pi) name only typed ones, and say when
 * each was sent (`prompt_at`), which is used instead of the moment a render first saw it.
 * Antigravity CLI names no prompt at all, so its is read from what its agent is doing, across two
 * renders (`promptFromActivity`, A47).
 */
export interface SeenPrompt {
  /** A digest of the host's prompt id. */
  readonly id: string;
  /** When a render first saw it, in epoch milliseconds. */
  readonly seen_at: number;
}

/** The prompt a payload names: its id, digested, and when it was sent if the host says. */
export interface NamedPrompt {
  readonly key: string;
  readonly at?: number;
}

/**
 * The payload's prompt, or null when it names none.
 *
 * An editor has no prompt of its own, the agent running elsewhere; it says when the person last
 * typed or clicked in its window (`input_at`), and that input stands where a prompt would.
 */
export function promptFromPayload(payload: string): NamedPrompt | null {
  if (payload.length === 0) return null;
  try {
    const parsed = JSON.parse(payload) as {
      prompt_id?: unknown;
      prompt_at?: unknown;
      input_at?: unknown;
    };
    const input = parsed.input_at;
    if (typeof input === "number" && Number.isFinite(input) && input > 0) {
      return { key: `input-${input}`, at: input };
    }
    const value = parsed.prompt_id;
    if (typeof value !== "string" || value.length === 0) return null;
    const key = new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 16);
    const at = parsed.prompt_at;
    return typeof at === "number" && Number.isFinite(at) && at > 0 ? { key, at } : { key };
  } catch {
    return null;
  }
}

/**
 * The latest prompt as of this render: the one already seen, or a new one, dated when the host
 * says it was sent or else now. A date in the future is now: a host's clock is not to be trusted
 * past this one.
 */
export function seenPrompt(
  previous: SeenPrompt | undefined,
  named: NamedPrompt | null,
  now: number,
): SeenPrompt | undefined {
  if (named === null) return previous;
  if (previous?.id === named.key) return previous;
  return { id: named.key, seen_at: Math.min(named.at ?? now, now) };
}

/** Whole seconds since the latest prompt, or undefined when none has been seen. */
export function inputAgeSeconds(prompt: SeenPrompt | undefined, now: number): number | undefined {
  return prompt === undefined ? undefined : Math.max(0, Math.floor((now - prompt.seen_at) / 1000));
}

/** Whether an editor's window was focused when it asked for this line; undefined elsewhere. */
export function focusedFromPayload(payload: string): boolean | undefined {
  try {
    const focused = (JSON.parse(payload) as { focused?: unknown }).focused;
    return typeof focused === "boolean" ? focused : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a host says the agent and the person are doing, kept from one render to the next.
 *
 * Antigravity CLI's payload names no prompt and no time (A47), but it says what the agent is doing
 * (`agent_state`), whether a tool-approval dialog is open (`tool_confirmation_pending`) and how
 * many messages are queued behind the running turn (`pending_input_count`). None of these is a
 * moment on its own. A change between two renders is, and the host renders on every change of
 * state, so the render that sees one is the first to know of it, as with Claude Code's
 * `prompt_id`.
 */
export interface HostActivity {
  readonly state?: string;
  readonly confirming?: boolean;
  readonly queued?: number;
}

/**
 * The activity a payload reports, or null when it reports none.
 *
 * Antigravity CLI leaves a field out when it is false or zero (checked against 1.4.2: neither
 * `tool_confirmation_pending` nor `pending_input_count` appears in an idle session's payload). So
 * where the payload reports an `agent_state` at all, a missing one of the other two is read as no
 * dialog open and nothing queued, and a dialog being answered shows as its field disappearing.
 */
export function activityFromPayload(payload: string): HostActivity | null {
  if (payload.length === 0) return null;
  try {
    const parsed = JSON.parse(payload) as {
      agent_state?: unknown;
      tool_confirmation_pending?: unknown;
      pending_input_count?: unknown;
    };
    const activity: { state?: string; confirming?: boolean; queued?: number } = {};
    if (typeof parsed.agent_state === "string") activity.state = parsed.agent_state.slice(0, 32);
    if (typeof parsed.tool_confirmation_pending === "boolean") {
      activity.confirming = parsed.tool_confirmation_pending;
    }
    const queued = parsed.pending_input_count;
    if (typeof queued === "number" && Number.isInteger(queued) && queued >= 0) {
      activity.queued = queued;
    }
    if (activity.state !== undefined) {
      activity.confirming ??= false;
      activity.queued ??= 0;
    }
    return Object.keys(activity).length === 0 ? null : activity;
  } catch {
    return null;
  }
}

/** The states Antigravity CLI reports while a turn runs, as against `idle` and `initializing`. */
const BUSY = new Set(["thinking", "working", "tool_use"]);

/**
 * A new prompt, dated now, when the activity since the last render shows the person acted.
 *
 * Three changes count:
 *
 *   - the agent went from `idle` to working, which is a turn starting, almost always on a message
 *     just sent. Like Claude Code's opaque id, it also counts a turn the agent starts itself;
 *   - a tool-approval dialog closed, which only a person answering it does;
 *   - the queue of messages grew, which is a person typing while the agent works.
 *
 * Nothing on a render with nothing to compare against, the session's first: a turn already
 * running when first seen started at some moment this render does not know, and dating it now
 * would make an old prompt look fresh. The key is new every time, because each change is its own
 * act, and is never derived from anything the person wrote.
 */
export function promptFromActivity(
  previous: HostActivity | undefined,
  current: HostActivity | null,
  now: number,
): NamedPrompt | null {
  if (previous === undefined || current === null) return null;
  const started =
    previous.state === "idle" && current.state !== undefined && BUSY.has(current.state);
  const answered = previous.confirming === true && current.confirming === false;
  const before = typeof previous.queued === "number" ? previous.queued : 0;
  const typed = current.queued !== undefined && current.queued > before;
  return started || answered || typed ? { key: `activity-${now}`, at: now } : null;
}

/**
 * The states in which a host is drawing its status line with no session in it yet.
 *
 * Antigravity CLI runs its `statusLine` from the first frame, its sign-in screen included, and
 * says so: `authenticating` there, with an empty `session_id`, and `initializing` while it starts.
 * `authenticating` is not in its documentation; it is what a real first run sent (A47).
 */
const NOT_IN_SESSION = new Set(["authenticating", "initializing"]);

/**
 * Whether the host is in an agent session, by its own account. True unless it says otherwise.
 *
 * A line drawn on a sign-in screen is shown to nobody using an agent, so it is an impression no
 * advertiser bought: the renderer draws nothing there, as an editor draws nothing without a live
 * agent (A21). A host that reports no state is taken to be in one, as every host was before.
 */
export function inSessionFromPayload(payload: string): boolean {
  if (payload.length === 0) return true;
  try {
    const state = (JSON.parse(payload) as { agent_state?: unknown }).agent_state;
    return typeof state !== "string" || !NOT_IN_SESSION.has(state);
  } catch {
    return true;
  }
}
