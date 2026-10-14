/**
 * The part of OpenCode 2's TUI plugin API this plugin uses, declared by hand.
 *
 * OpenCode 2 loads a TUI plugin whose default export is `{ id, setup(context) }` and rejects any
 * other shape as an "Invalid V2 TUI plugin module" (2.0.29, `packages/tui/src/plugin/context.tsx`).
 * Its API is published as `@opencode/plugin/tui`, but that package's types bring OpenTUI 0.5 and
 * the whole of OpenCode 2's client with them, while this package compiles against the OpenTUI that
 * OpenCode 1 ships. So the few members read here are copied from `@opencode/plugin@2.0.29`
 * (`src/tui/context.ts`, `src/tui/plugin.ts`), narrowed to what is used, and nothing else is
 * assumed.
 */
import type { JSX } from "@opentui/solid";

/**
 * Where OpenCode 2 is: `home`, `session` with its id, or a plugin's page.
 *
 * Read as an open shape rather than the host's union, so a route added later reads as "not a
 * session" instead of breaking this.
 */
export interface OpenCode2Route {
  readonly type: string;
  readonly sessionID?: string;
}

/**
 * One message of a session, as far as this plugin reads it.
 *
 * The author is in the type: what the person sent is `user`, and text OpenCode writes itself is a
 * `synthetic` message (or `system`, `skill`, `shell` and the rest), never a `user` one. `created`
 * is epoch milliseconds.
 */
export interface OpenCode2Message {
  readonly id: string;
  readonly type: string;
  readonly time: { readonly created: number };
}

export interface OpenCode2Context {
  readonly ui: {
    readonly router: { current(): OpenCode2Route };
    /**
     * A place in the host's slot tree, released by the returned function. `append` puts the
     * render last inside the named slot, and the host calls the render once, untracked.
     */
    slot(claim: { readonly append: "app"; readonly render: () => JSX.Element }): () => void;
  };
  readonly data: {
    readonly session: {
      readonly message: { list(sessionID: string): readonly OpenCode2Message[] };
    };
  };
}

/** What OpenCode 2 loads. The teardown `setup` returns runs when the plugin is turned off or reloaded. */
export interface OpenCode2Plugin {
  readonly id: string;
  readonly setup: (context: OpenCode2Context) => () => void;
}
