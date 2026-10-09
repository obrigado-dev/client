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
