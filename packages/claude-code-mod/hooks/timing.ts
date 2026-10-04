/**
 * The session's timing, kept by the mod because the mods API does not carry it.
 *
 * Claude Code hands its status line `cost.total_duration_ms` and `cost.total_api_duration_ms`,
 * and the classifier reads the difference as time a person spent: someone reading and typing
 * leaves long stretches with no model request in flight, while a scripted run goes from one
 * response straight into the next request. A hooks module is given neither figure, so this keeps
 * both. The wall clock starts at the mod's own `session.start`; each model request is timed
 * around `turn.step`. They go to the renderer in the status line's own two fields, so the
 * renderer reads them exactly as it reads the status line's.
 *
 * Requests add up as they do for the status line: a subagent's count as well as the main loop's,
 * and two in flight at once count twice. That only ever shrinks what the classifier reads as a
 * person's time, which is the direction §7 wants an error to fall.
 *
 * Apart from the hooks module so it can be tested without Claude Code.
 */

/** The status line's `cost` fields this rebuilds, under the status line's names. */
interface StatusLineCost {
  readonly total_duration_ms: number;
  readonly total_api_duration_ms: number;
}

export interface SessionTiming {
  /** Starts the session's clock over at `now`, in `$.clock.now()` milliseconds. */
  readonly start: (now: number) => void;
  /** Adds one model request, in flight from `startedAt` to `endedAt`. */
  readonly request: (startedAt: number, endedAt: number) => void;
  /** The two figures at `now`, or none before the clock has started. */
  readonly cost: (now: number) => StatusLineCost | undefined;
}

export function sessionTiming(): SessionTiming {
  let startedAt: number | null = null;
  let requestMs = 0;
  return {
    start: (now) => {
      startedAt = now;
      requestMs = 0;
    },
    // A clock that stepped backwards adds nothing, rather than taking time off the requests.
    request: (from, to) => {
      requestMs += Math.max(0, to - from);
    },
    cost: (now) =>
      startedAt === null
        ? undefined
        : { total_duration_ms: Math.max(0, now - startedAt), total_api_duration_ms: requestMs },
  };
}
