# obrigado-vscode

Obrigado's editor surface: one labeled sponsored line in the status bar. Cursor inherits it
by being a VS Code fork.

**It renders only alongside a live agent session — see "When it shows" below.**

## Why a status bar item

`vscode.window.createStatusBarItem` is a documented API giving persistent text, a tooltip,
and a command on click. Using it means no other extension's bundle is read, rewritten or
re-signed, and no Content-Security-Policy is relaxed.

Staying within this documented API is the extension's security and compatibility boundary:
no injection, policy changes, or mutation of another extension's files (INVARIANT 11, §3).

## How it delivers

Runs `obrigado statusline --agent vscode|cursor --json` and renders the parts, exactly as the
OpenCode plugin does. Rotation, batching, beacons and the disclosure stay in the one
renderer Claude Code already drives — there is no second delivery path.

The host is read from `vscode.env.appName`, so one extension serves both editors and the
impression still records which one rendered it. Reporting "vscode" for a Cursor user would
blur two populations no rollup joins back together.

Clicks open the signed `/c/:token` URL through `vscode.env.openExternal`, never the
advertiser's destination directly: the redirect is what records the click and sanitises
where it lands.

The label is part of the item's text and is never separated from the copy, so there is no
state in which the advertisement is visible and the disclosure is not. Any failure hides
the item — the editor then looks exactly as it did before the extension was installed,
which is the correct failure for an advertisement.

## When it shows

An editor placement is visible whenever the window is, including while somebody reads code
with no agent involved. Every other Obrigado surface lives inside an agent's own UI, so an
impression there *implies* an agent was running — which is the assumption §14's viewability
rules are built on.

So an editor surface renders **only while an agent session is live**: the client checks
whether any agent host (Claude Code, Codex, OpenCode) has rendered within the last five
minutes, and returns nothing otherwise. The editor item is a companion to a running agent,
in a place the agent's own UI cannot reach — not independent inventory (A21).

Two details that make the gate mean something:

- **It lives in the client, not here.** One rule governs every editor host, and an
  extension cannot opt itself into billing by forgetting to ask.
- **Editor hosts are excluded from their own evidence.** If a `vscode` render counted as
  proof that an agent was running, the first one would qualify every render after it and
  the question would answer itself forever.

Nothing renders rather than rendering-without-billing: a line shown to someone with no
agent running is an impression the advertiser did not buy, whether or not it is counted.

Ambient editor placement — earning whenever visible — remains possible later as its own
inventory with its own price. Session-scoped is a strict subset, so this order keeps that
option open; the reverse would not.

## What this surface can render

**The status bar is the whole extension**, and that is a decision rather than a limit we ran
into. It is the only thing here visible without a click.

`StatusBarItem.text` supports Codicons (`$(name)`) and nothing else — no per-run colour, no
bold, italic or underline. It renders `$(sparkle) sponsored · copy`, and the glyph is the
whole of what that prototype can be on this surface. Not a `~spin` variant: a spinning glyph
in a status bar reads as work in progress, which is the note the animated OpenCode version
already got.

There is a single `color` for the entire item and it is deliberately unset. Setting it would
tint the disclosure along with the copy, and the slot is chosen by the advertiser against a
status bar background we do not control — `statusBar.noFolderBackground` is purple, and a
magenta creative on it is unreadable. Two adjacent items would separate those concerns, and
are worse: any extension whose priority falls between them lands *between* the label and the
ad it labels.

**The hover carries what the item cannot.** A `MarkdownString` tooltip, so bold, italic and
the link all render, and hovering costs no click. Colour does not survive and is not faked —
markdown has none, and the alternative is trusted HTML built partly from advertiser input.

Advertiser text is escaped for both, and the escaping differs because the hazards do:
markdown constructs in the hover, `$(` in the status bar. The one that costs money is
markdown — an unescaped link construct in copy renders a live link of the advertiser's
choosing, which bypasses the signed `/c/` redirect entirely and with it both the click record
and the destination check.

## The webview panel, and why it is gone

There was one: a `WebviewView` rendering the full creative in real HTML — per-span colour,
bold, italic, underline, reverse-video highlight, and the only place in an editor where an
advertiser logo could ever be an `<img>` rather than something smuggled through a terminal
escape.

It was removed because **no placement it could reach was one anybody would look at.** An
extension gets its own view container, and a container is a TAB: in the secondary sidebar it
is mutually exclusive with the chat beside it, and in the bottom panel it lands in the
overflow behind "Additional Views". Both require a deliberate click to see an advertisement,
which is not a thing people do. Contributing into another extension's container is reachable
and was rejected — it would render a sponsored strip inside a pane titled "Claude Code",
making another publisher look like they sell ads.

Two things went with it, and both are worth knowing before anyone rebuilds it:

- **Colour has nowhere to land in an editor.** The wire still carries `color` and
  `highlight` per span; nothing in this host renders them.
- **Imagery is blocked anyway.** A logo needs a `brand` field on the wire that does not
  exist yet, so the panel could not have shown one today even where it was visible.

If it comes back, it should come back with the asset pipeline that justifies it, and under a
**new view id** — see below.

## View ids are cached harder than they are reloaded

The editor stores per-view state under the view id, in global storage that survives
uninstalling the extension: which container it was dragged to (`views.customizations`),
whether the container is pinned to the panel bar (`pinnedPanels`), and a placeholder
descriptor carrying whatever `when` clause the manifest had at the time.

A stored location **overrides the declared one**. Move a view to a different container and
the old location keeps winning, the declared container is left with no views, and a container
with no views is not rendered at all — so the tab does not exist to be found. The extension
activates cleanly throughout, which makes it indistinguishable from a bug in our own code.
This cost an afternoon and was diagnosed by reading Cursor's `state.vscdb` directly.

`View: Reset View Locations` clears it for one developer. Shipping a view that changed
containers needs a new id, because nobody else runs that command.

## Building and installing

```sh
bun run package        # bundle, then vsce → dist/obrigado-vscode.vsix
bun run install:code   # or install:cursor
```

Then **Developer: Reload Window**. The `.vsix` is ~14 KB and contains the bundle, the
manifest, the icons and this README — `bun build` inlines every import, so there is no
runtime dependency to carry and `--no-dependencies` says so to `vsce`.

For iterating, skip packaging entirely and run the extension straight from the checkout:

```sh
bun run build
cursor --extensionDevelopmentPath=/absolute/path/to/packages/vscode-extension
```

`obrigado.statuslineCommand` in settings points at a source checkout of the client. It exists
because an editor launched from the Dock inherits no shell environment, so the env-var form
works when the editor was started from a terminal and silently does not otherwise.

## Also not done

- **No Marketplace identity.** `publisher: "obrigado"` is unclaimed. It needs to be
  reserved before `vsce publish` is anything but a way to lose the name to somebody else.
- **No published release.** Release packages will be built from the Apache-2.0-licensed
  [public client source](https://github.com/obrigado-dev/client), but none exists yet.
- **Not wired into `obrigado install`.** Editor extensions install from the Marketplace
  rather than by writing a config file, so the installer's job here is likely to *detect*
  and point at it rather than to place anything.
- **Nothing verifies the panel's own tab is ever selected.** The status bar carries the
  placement precisely because it needs no selection; the panel earns its keep only once
  somebody drags it somewhere they already look, and there is no measurement of how often
  that happens.
