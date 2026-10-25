# @obrigado/pi-extension

Obrigado's surface for [Pi](https://github.com/badlogic/pi-mono) and oh-my-pi.

One sponsored line, as a keyed entry on the host's footer status line.

## What it does

Pi composes its footer from keyed entries: every extension calls
`ctx.ui.setStatus(key, text)`, and the host sorts those entries by key, joins them, and draws
the result beneath its own working-directory and token-stats lines. This extension owns one
key, `obrigado`, and nothing else.

It deliberately does **not** call `ctx.ui.setFooter`, which replaces the built-in footer
outright. An ad that took that route would be deleting the model name, the context gauge and
the working directory to make room for itself.

Delivery is not reimplemented here. `obrigado statusline --agent pi` already performs rotation,
batching, beacons, dwell and the disclosure, and returns a finished ANSI line — which is
exactly what `setStatus` accepts.

## Installation

```sh
obrigado install --agent pi         # ~/.pi/agent/extensions/obrigado.ts
obrigado install --agent oh-my-pi   # ~/.omp/agent/extensions/obrigado.ts
```

A bare `obrigado install` installs into whichever of the two it finds. Restart the host
afterwards; extensions are discovered at startup.

`obrigado uninstall --agent pi` removes the file, and removes it only if the contents are still
ours — a copy you have edited is left where it is.

Both hosts read the same `PI_CODING_AGENT_DIR` override. If it is set, they resolve to the same
directory and only one extension file can live there, so the installer writes for the host you
named rather than silently letting the second overwrite the first.

## Two things worth knowing

**The agent id is written at install time.** The file contains one line, `const AGENT = "pi"`,
which the installer rewrites for oh-my-pi. It namespaces per-session state and attributes the
impression, so the two hosts cannot consume each other's inventory.

**Hyperlinks are on in Pi and off in oh-my-pi.** Pi's footer truncator drops the ANSI past the
cut, the closing half of an OSC 8 link included, but Pi has closed every rendered line's links
since 0.43.0, so a cut link ends at the footer's edge. oh-my-pi's status handling is not verified
to do the same, so there the extension runs the renderer with `OBRIGADO_HYPERLINKS=0` and the copy
is coloured and unclickable.

## Development

```sh
OBRIGADO_STATUSLINE_COMMAND="bun /path/to/packages/client/src/cli.ts statusline" omp
```

The extension appends `--agent` itself, so the override names the command only.
