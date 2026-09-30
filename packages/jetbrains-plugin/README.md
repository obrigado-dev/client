# obrigado-jetbrains

Obrigado's surface in every IntelliJ-based IDE — IntelliJ IDEA, PyCharm, WebStorm, GoLand,
RustRover, CLion, Rider, PhpStorm, RubyMine, DataGrip, Android Studio: one labeled sponsored
line in the status bar.

**It renders only alongside a live agent session**, exactly as the VS Code extension does —
see that package's README under "When it shows". The gate is the renderer's, not this
plugin's.

## Why a status bar widget

`com.intellij.statusBarWidgetFactory` is a documented extension point
([Status Bar Widgets](https://plugins.jetbrains.com/docs/intellij/status-bar-widgets.html)),
and it is the platform's rather than any one IDE's, so one plugin covers all of them. It gives
persistent text, a tooltip and a click, in a slot the IDE owns: the developer can hide it from
the status bar's own right-click menu, like any other widget. Nothing of the IDE is patched and
no other plugin's classes are touched (INVARIANT 11, §3).

It is registered `order="first"`: the far end of the status bar is where the caret position,
encoding and inspections live, and a sponsored line should not sit among the IDE's own state.

## How it delivers

Runs `obrigado statusline --agent jetbrains --json` every 30 seconds per project window and
draws the parts, exactly as the VS Code extension and the OpenCode plugin do. Rotation,
batching, beacons and the disclosure stay in the one renderer.

- **One agent id for every JetBrains IDE.** They are one platform running one plugin, not
  forks of each other. The IDE's build (`IU-262.10968.63`, `PY-…`, `WS-…`) rides the payload
  as the host version, so the impression still says which IDE rendered it.
- **The first line settles the render.** The renderer prints its line and then ships beacons;
  the child is never killed for being slow after it has answered. One that says nothing within
  two seconds is.
- **The shell's environment, not the IDE's.** An IDE opened from the Dock inherits almost no
  environment, so the plugin runs the renderer with the login-shell environment the IDE loads
  at startup. `obrigado` is looked up on that PATH, then in `~/.local/bin` (or
  `OBRIGADO_INSTALL_DIR`), where `install.sh` puts it.
- **Every failure hides the widget.** No renderer, no config, no agent session, a timeout, a
  malformed line: the status bar looks exactly as it did before the plugin was installed.
- **Clicks open the signed `/c/:token` URL**, never the advertiser's destination directly, and
  only over `https` (or `http` to a loopback host, for a development stack).

`surface_version` is read from the running plugin's own descriptor rather than written down a
second time, so it cannot disagree with what is installed.

## What this surface can render

Text, a tooltip and a click. The widget text is `oss-sponsor · copy` in the status bar's own
font and colour; per-run colour has nowhere to land, as in VS Code. Swing renders any string
that starts with `<html>` as HTML, so status text is never allowed to start with it — the Swing
twin of VS Code refusing `$(` in item text.

The tooltip is HTML and carries what the text cannot: the label in bold, the runs' bold and
italic, and the footer. Every piece of advertiser text in it is escaped. The brand's logo is not
drawn: Swing's HTML cannot draw a `data:` URI, and fetching an image from anywhere else would
hand the advertiser a developer's IP address from inside their IDE.

## `@obrigado/surface`, in Kotlin

`Surface.kt` is a copy of the TypeScript package — the line's shape, the checks on it, and the
argv split — because a JVM host cannot import it. `packages/surface/test/vectors.json` holds the
two together: the TypeScript tests assert the vectors describe that implementation, and
`VectorsTest` asserts this one gives the same answers.

`Json.kt` is a small RFC 8259 reader rather than one of the IDE's bundled JSON libraries. Which
of those a plugin may link against has moved between releases, and a class that resolves in the
IDE this was built against and not in the next one fails in somebody's status bar, not here.

## Building

Needs JDK 21; the Gradle wrapper fetches everything else, including the IntelliJ Platform it
compiles against (the 2025.1 Community distribution, about a gigabyte, cached after the first
build).

```sh
./gradlew check          # the unit tests, including the vectors
./gradlew buildPlugin    # build/distributions/obrigado-jetbrains-<version>.zip
./gradlew verifyPlugin   # the Plugin Verifier, against the recommended IDE releases
./gradlew runIde         # a sandbox IDE with the plugin installed
```

To point the plugin at a source checkout of the client, export `OBRIGADO_STATUSLINE_COMMAND`
in your shell profile — the IDE reads the login shell's environment, so it applies however the
IDE was launched:

```sh
export OBRIGADO_STATUSLINE_COMMAND="bun /path/to/client/packages/client/src/cli.ts statusline"
```

The zip installs through **Settings → Plugins → ⚙ → Install Plugin from Disk…**.

## Compatibility

Compiled against 2025.1 (build 251), the oldest release it claims, with no upper bound: it
uses one documented extension point and a few long-stable utilities, and capping it would make
every IDE release a forced update. Kotlin is compiled with `apiVersion` 2.1 because the IDE
supplies the standard library, and 2025.1 bundles 2.1.

## Also not done

- **No Marketplace listing.** The vendor profile is unclaimed, and JetBrains reviews every
  plugin. Its guidelines rule out "features for additional promotion", which a reviewer may
  read as covering a sponsored line; if so, the fallback is a custom plugin repository served
  from obrigado.dev, which every JetBrains IDE supports.
- **Not wired into `obrigado install`.** Like the VS Code extension, it arrives from the
  host's own gallery, so the installer's job is to detect the IDE and point at it.
