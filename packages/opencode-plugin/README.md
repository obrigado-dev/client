# @obrigado/opencode-plugin

Obrigado's OpenCode surface: one sponsored line in the host's own bottom bar, with the
advertiser's copy as a real clickable link.

## Why a plugin rather than a config key

OpenCode has no `statusLine` setting. Its config schema contains no `statusline`, `tui`,
`footer`, or `widget` key, and there is no built-in item list to extend the way Codex has.
Requests for one are open ([#8619](https://github.com/anomalyco/opencode/issues/8619),
[#30295](https://github.com/anomalyco/opencode/issues/30295),
[#23539](https://github.com/anomalyco/opencode/issues/23539)).

What OpenCode has instead is better than either: a TUI plugin API where a plugin registers
Solid components into named slots of the host's layout. The slot under the routed screen
(`app_bottom` in OpenCode 1, `app` in OpenCode 2) is persistent and host-owned, which is the
property that makes a status line a countable impression and a toast not.

**This is why OpenCode gets an integration and Codex does not.** Codex's reachable surfaces
were a warning cell, an Enterprise-only push field, the model's own plan output, and the
developer's thread title — see `docs/SPEC-AMENDMENTS.md` A19. The decisive difference is
clickability: OpenTUI exposes `a` with an `href`, so the creative is a genuine link.
Codex rendered Markdown literally and stripped OSC 8, and that is what disqualified it.

## How it delivers

The slot component runs:

```
obrigado statusline --agent opencode --json
```

and composes the result with OpenTUI's own primitives. Rotation, batching, beacons, dwell
and the disclosure all stay in the single renderer that Claude Code already drives — the
`--json` flag is a second *serialisation*, not a second delivery path. A host that draws
its own UI cannot consume an ANSI string, and handing it one would force exactly the
render-literally-or-strip failure that sank Codex.

The label sits outside the link, as it does in the terminal renderer: what is clickable is
the advertiser's copy, and nobody can click the disclosure itself and land on an advertiser.

Every failure renders nothing, leaving OpenCode looking exactly as it did before the plugin
was installed. That is the correct failure for an advertisement.

## OpenCode 1 and 2

OpenCode 2 is a rewrite published beside OpenCode 1 (`opencode` on npm for 2, `opencode-ai` for
1), with a TUI plugin API of its own. One module serves both, each host finding its own entry
point on the default export (A42):

| | OpenCode 1 (1.18.10 on) | OpenCode 2 (2.0.29) |
|---|---|---|
| Requires of the default export | `tui(api)`, and no `server()` beside it | a non-empty `id` and `setup(context)` |
| Where the line goes | `app_bottom`, `order: 90` | appended to `app` |
| The open session | `api.route.current.params.sessionID` | `context.ui.router.current()`, `{ type: "session", sessionID }` |
| The person's last message | newest `user` message with a text part neither `synthetic` nor `ignored` | newest `user` message; OpenCode's own text is a `synthetic` message |
| Teardown | `api.lifecycle.onDispose` | the function `setup` returns |
| Plugin list | `tui.json`, `plugin` | `cli.json`, `plugins`, carried over from `tui.json` once |

Neither host rejects the other's key, so `{ id, tui, setup }` loads in both. 0.3.0 exported
only `tui`, and OpenCode 2 refused it as an "Invalid V2 TUI plugin module".

The two draw differently in one respect. OpenCode 1 calls a slot's callback inside its own
tracking scope, so reading the creative there swaps the row when it rotates; OpenCode 2 calls a
claim's render once and untracked, so the rotation is a keyed `Show` instead. OpenCode 2's claims
also carry no order: claims at one place draw in the order their plugins were enabled.

`dist/tui.js` is one build for both. The JSX helpers it imports (`createElement`, `insert`,
`setProp`, `createComponent`…) and the elements it uses (`box`, `text`, `span`, `a`,
`ascii_font`) are the same in OpenTUI 0.4.5, which OpenCode 1 ships, and 0.5.17, which OpenCode 2
ships, and each host rewrites `solid-js` and `@opentui/*` to its own copy. OpenCode 2's API is
declared by hand in `src/opencode2.ts`, narrowed to what is read, because `@opencode/plugin`'s
own types bring OpenTUI 0.5 and OpenCode 2's whole client with them.

## Install

```bash
obrigado install --agent opencode
```

That appends one entry to `plugin` in `~/.config/opencode/tui.json` (or
`$XDG_CONFIG_HOME/opencode`), and, once OpenCode 2 has made its own `cli.json`, one to that
file's `plugins` too, preserving every other key, backing each file up first, and writing
atomically. `obrigado uninstall --agent opencode` removes only those entries, and drops a key
entirely if nothing else is in it. A file that cannot be parsed — comments are legal there and
illegal in JSON — is refused rather than rewritten from a lossy parse, and the install stops
before writing either.

`cli.json` is never created. OpenCode 2 fills it from `tui.json` the first time it runs, our
entry included, and a `cli.json` that already existed would stop it carrying over the rest of
the developer's settings.

Restart OpenCode after installing. By hand, the entries are:

```jsonc
// ~/.config/opencode/tui.json, which OpenCode 1 reads
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@obrigado/opencode-plugin@0.4.0"]
}
// ~/.config/opencode/cli.json, which OpenCode 2 reads (`$OPENCODE_CONFIG_DIR` when set)
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@obrigado/opencode-plugin@0.4.0"]
}
```

The package, not `@obrigado/opencode-plugin/tui`: OpenCode finds `./tui` in the package's
`exports` itself, and npm's spec parser reads a spec with a subpath as a local directory, so
OpenCode installs nothing and says nothing. Installs before 0.3.3 wrote that form.

At a version, because OpenCode never asks npm again about a plugin it has installed: an unpinned
spec stays on the first version it got. Change the version to update. The CLI does this for you
(A41): it writes the version it shipped with, and moves the pin in both files after it updates
itself. OpenCode 2 caches the same way, so its pin moves the same way (A42).

From a source checkout, point the plugin at your client with `OBRIGADO_STATUSLINE_COMMAND`.

## Verified against a running OpenCode

`opencode` 1.18.10, Ghostty (via cmux), 2026-08-08, with the plugin loaded from a local path
rather than from npm:

- **`app_bottom` renders**, on the home screen and mid-session, persisting across both.
- **The link works.** Cmd+click on the copy opens the signed `/c/:token` URL. This was the
  open question the whole integration turned on — it is what Codex could not do — and the
  answer is yes.
- OpenCode compiled the plugin from TypeScript source, so no build step was needed. That holds
  only from a local path: OpenTUI's Solid transform skips everything under `node_modules`, where
  an npm install puts the package, so from npm the source never loaded. Since 0.2.0 the package
  ships `dist/tui.js`, compiled by `build.ts` with the host's modules left external.

`opencode` 2.0.29 and `opencode-ai` 1.18.35 in tmux, 2026-10-14, each with its own `HOME` and
XDG directories (2 with `--standalone`), the renderer replaced by a fixture through
`OBRIGADO_STATUSLINE_COMMAND`, a provider pointed at a closed localhost port, and 0.4.0's
`dist/tui.js` in place of the published 0.3.0 where each host's npm cache had installed it:

- **Published 0.3.0 fails in OpenCode 2** as reported: "Plugin failed:
  @obrigado/opencode-plugin@0.3.0".
- **0.4.0 draws in both**, on the home screen and in a session, under the routed screen. The
  payload carries `surface_version` 0.4.0 and, in a session, its `ses_…` id and the typed
  message's `msg_…` id and time in epoch milliseconds.
- **Turning it off stops it in both** (`/plugins` in 2, the command palette's Plugins in 1): the
  line goes, and nothing runs the renderer in the 45 seconds after. Turned back on in 2, it
  fetches at once. Published 0.3.0 did not stop in OpenCode 1: disabled, it went on running the
  renderer every 30 seconds with nothing drawn, because its teardown was never handed to the host.
- A `file:` tarball spec is no way to test a build in OpenCode 2: installed from one, the same
  `dist/tui.js` fails with "Cannot find package '@opentui/solid'" from a cache path that contains
  `file:`. Replace the files of a registry install instead.

## Known defects

1. **No colour or emphasis.** `--json` returns only `{label, copy, url}`, dropping the
   creative's `spans`, `style` and `effect`, so the line renders flat while the same
   creative carries the advertiser's palette in Claude Code. The mapping is close to 1:1 —
   `@opentui/solid` sets `node.fg`/`node.bg`/attributes from a `style` prop, and obrigado's
   palette is already named colours (`cyan`, `blue`, `green`, `magenta`) plus bold, italic
   and reverse-video highlight. Underline must stay reserved for real links, as it is in
   the terminal renderer.
2. **Placement.** The line sits flush at column 0, below OpenCode's own status row and
   outside the frame's padding, so it reads as a detached band rather than part of the
   chrome. Needs the host's padding, and `home_footer` is worth comparing against
   `app_bottom`.

## Hover, and the two ways it latched

Hovering brightens the copy. Getting it to *stop* took reading OpenTUI's dispatch, which
emits `out` only when a later `move` event hit-tests to a different element:

```js
if (!sameElement && (type === "drag" || type === "move")) {
  if (lastOverRenderable && !lastOverRenderable.isDestroyed) → emit "out"
  ...
}
```

Two consequences, and the first made the initial attempt stick permanently:

1. **`isDestroyed` swallows the leave.** Each refresh replaces the row, so a pointer resting
   on it when a creative rotated left the flag set with nothing alive to clear it, and the
   replacement rendered emphasised forever. Hover is now dropped before the swap.
2. **Leaving the window emits nothing.** This row sits on the bottom edge, so the pointer
   usually exits downward and no further event arrives. That case self-heals on the next
   in-window movement or the next refresh, whichever comes first — bounded rather than
   eliminated.

A root-level listener would close the second, since events bubble and `renderer.root` sees
all of them. It is not worth it: `onMouse` is a single slot with no getter, so installing
ours would silently replace OpenCode's own handler. Reading the pointer does not justify
breaking the host's, which is what INVARIANT 11 exists to prevent.

Handlers must go on the row's box regardless — `LinkProps` is `SpanProps & { href }`, and
inline text nodes take no `on*` props.

## A note on plugin specs

OpenCode resolves a spec as a PACKAGE, not a file: it reads the target's `package.json` and
looks for `exports["./tui"]`. Pointing `tui.json` at `src/tui.tsx` directly silently
registers nothing — there is no manifest, so no `tui` target is produced, and OpenCode logs
neither success nor failure. Use the package name (or, from a checkout, the package
directory).

## No build step is needed

Earlier notes here claimed this package needed `tsup` + `esbuild-plugin-solid` before it
could ship. That was wrong. OpenCode **bundles the Solid runtime transform** — its binary
carries `Symbol.for("opentui.solid.runtime-plugin-support")` and Bun `onLoad` hooks that
babel-transform plugin sources and alias `@opentui/solid`, `@opentui/solid/jsx-runtime` and
`solid-js` to its own copies. So a TUI plugin ships TypeScript source and the host compiles
it, which is why this package has no `build` script and why the repo still has no bundler.

## Stability

OpenCode 1's TUI plugin API is undocumented — there is no docs page, and the host that loads
it is named `createLegacyTuiPluginHost`. The types here come from `@opencode-ai/plugin@1.18.10`
and `@opentui/solid@0.4.5`. Treat it as movable.

OpenCode 2's is published, as `@opencode/plugin/tui`, and calls its slot paths documented API,
"coarse, few, and kept stable across host refactors" (`SlotMap`, 2.0.29). A claim aimed at a
path the host stops publishing is appended to the nearest surviving ancestor rather than
dropped. The members this package reads are copied from 2.0.29 into `src/opencode2.ts`; check
them against a new major before trusting it.
