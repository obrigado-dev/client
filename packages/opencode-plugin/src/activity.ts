/**
 * What a session has been doing, so the line is drawn again only after something happened.
 *
 * The line was drawn every thirty seconds whatever happened, so an OpenCode left open and idle,
 * even on its home screen, went on counting a line every thirty seconds, billed while measurement
 * lasts. A terminal's status line redraws only on the conversation's events. This is the same rule,
 * read from what the plugin can see: the agent at work, or the session's messages changed since the
 * line on screen was drawn. Its own module so it can be tested without loading the plugin.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

import type { OpenCode2Context } from "./opencode2.ts";

/** A session's state, as the line's beat reads it. */
export interface Activity {
  /** Whether the agent is at work now. */
  readonly working: boolean;
  /** Changes whenever the session's messages do: one typed, or a reply. */
  readonly mark: string;
}

/** Nothing to read: the home route, or a host without the state API. Never working or changing. */
export const STILL: Activity = { working: false, mark: "" };

const markOf = (messages: ReadonlyArray<{ readonly id: string }>): string =>
  `${String(messages.length)}:${messages.at(-1)?.id ?? ""}`;

/** OpenCode 1: the session's messages and its status, idle, busy or retrying. */
export function sessionActivity(api: TuiPluginApi, sessionId: string): Activity {
  try {
    const status = api.state.session.status(sessionId);
    return {
      working: status !== undefined && status.type !== "idle",
      mark: markOf(api.state.session.messages(sessionId)),
    };
  } catch {
    return STILL;
  }
}

/** OpenCode 2: the same, where a session's status is `idle` or `running`. */
export function sessionActivity2(context: OpenCode2Context, sessionId: string): Activity {
  try {
    return {
      working: context.data.session.status(sessionId) === "running",
      mark: markOf(context.data.session.message.list(sessionId)),
    };
  } catch {
    return STILL;
  }
}

/**
 * Whether the beat draws a new line: the agent is at work, or the session or its messages are not
 * what they were when the line on screen was drawn (`drawnAt`, null before the first).
 */
export function drawsAgain(drawnAt: string | null, now: string, working: boolean): boolean {
  return working || drawnAt !== now;
}
