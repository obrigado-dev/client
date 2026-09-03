# @obrigado/surface

What a host that draws its own UI needs from [Obrigado](https://obrigado.dev)'s renderer, and
nothing else.

Obrigado puts one labeled sponsored line in a coding agent's status line, and 70% of the
revenue funds the open-source packages the developer's project depends on. There is one
renderer, `obrigado statusline`, and every host serialises from it. A host that composes the
line from parts rather than printing an ANSI string — OpenCode's TUI plugin, the VS Code
extension — runs `obrigado statusline --agent <host> --json` and draws what it is handed.

This package is the three things every such host needs, once, with no dependencies and no I/O:

- **The shape** of one `--json` line: `Sponsored`, `SponsoredSpan`, `SponsoredBrand`, and the
  palette a span may ask for.
- **`parseSponsored(line)`** — a complete line, or `null`. Label, copy and URL or nothing: a
  creative without its label is an undisclosed advertisement, and one without its URL is an
  impression nobody can act on. Unknown colours degrade to the host's foreground.
- **`statuslineArgv(agent, override?)`** and **`splitCommand(text)`** — the argv to spawn, with
  a quote-aware split so a source checkout under a path with a space still runs.

```ts
import { parseSponsored, statuslineArgv } from "@obrigado/surface";

const [bin, ...args] = statuslineArgv("my-host", process.env["OBRIGADO_STATUSLINE_COMMAND"]);
// spawn bin with args, write `{ "session_id": …, "cwd": … }` to stdin, read the first line
const ad = parseSponsored(firstLine);
if (ad !== null) draw(ad.label, ad.spans, ad.url);
```

A host never fetches, counts or formats an ad itself; rotation, batching, beacons and the
disclosure stay in the renderer. That is what keeps "always labeled" a property rather than a
convention. To add a host, see `docs/ADDING-A-SURFACE.md` in the
[client repository](https://github.com/obrigado-dev/client).

Apache-2.0.
