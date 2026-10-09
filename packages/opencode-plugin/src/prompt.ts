/**
 * The person's latest typed message in an OpenCode session: what the plugin hands the renderer
 * so the server's attention rule can tell how long ago someone was there.
 *
 * Its own module so it can be tested without loading the plugin, whose entry keeps one export.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

/** A message the person typed: its id and when it was sent. */
export interface TypedPrompt {
  readonly id: string;
  readonly at: number;
}

/**
 * The person's latest typed message in this session, for the renderer's prompt signal, which the
 * server's attention rule reads: a line counts as seen only for a few minutes after one.
 *
 * Typed means a text part OpenCode did not write itself. Text OpenCode adds (`synthetic`) or
 * leaves out of the conversation (`ignored`) is not a person, so a message made only of that is
 * skipped. Only the id and the time leave this function, never the text. Null on the home route,
 * on an OpenCode whose plugin API has no session state, and before the first message.
 */
export function lastTypedPrompt(api: TuiPluginApi, sessionId: string): TypedPrompt | null {
  try {
    const messages = api.state.session.messages(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message === undefined || message.role !== "user") continue;
      const typed = api.state
        .part(message.id)
        .some((part) => part.type === "text" && part.synthetic !== true && part.ignored !== true);
      if (typed) return { id: message.id, at: message.time.created };
    }
  } catch {
    // An OpenCode older than the state API: no prompt, so no attention claimed.
  }
  return null;
}
