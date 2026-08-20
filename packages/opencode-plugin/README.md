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
Solid components into named slots of the host's layout. `app_bottom` is persistent and
host-owned, which is the property that makes a status line a countable impression and a
toast not.

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
the advertiser's copy, and nobody can click the word "sponsored" and land on an advertiser.

Every failure renders nothing, leaving OpenCode looking exactly as it did before the plugin
was installed. That is the correct failure for an advertisement.

## Install

```bash
obrigado install --agent opencode
```

That appends one entry to `plugin` in `~/.config/opencode/tui.json` (or
`$XDG_CONFIG_HOME/opencode`), preserving every other key, backing the file up first, and
writing atomically. `obrigado uninstall --agent opencode` removes only that entry, and drops
the key entirely if nothing else is in it. A `tui.json` that cannot be parsed — comments are
legal there and illegal in JSON — is refused rather than rewritten from a lossy parse.

Restart OpenCode after installing. By hand, the entry is:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@obrigado/opencode-plugin/tui"]
}
```

From a source checkout, point the plugin at your client with `OBRIGADO_STATUSLINE_COMMAND`.

## Verified against a running OpenCode

`opencode` 1.18.10, Ghostty (via cmux), 2026-08-08:

- **`app_bottom` renders**, on the home screen and mid-session, persisting across both.
- **The link works.** Cmd+click on the copy opens the signed `/c/:token` URL. This was the
  open question the whole integration turned on — it is what Codex could not do — and the
  answer is yes.
- OpenCode compiles the plugin from TypeScript source; no build step was needed.

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

The TUI plugin API is undocumented — there is no docs page, and the host that loads it is
named `createLegacyTuiPluginHost`. The types here come from `@opencode-ai/plugin@1.18.10`
and `@opentui/solid@0.4.5`. Treat it as movable.
