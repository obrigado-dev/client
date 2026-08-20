# Adding a surface

A *surface* is the place a host shows a status line. New coding agents and terminals appear
constantly, and adding support for one is the most useful change an outside contributor can
make — it is self-contained, it is testable, and nobody on this side has to have used the host
to review it.

This is what that change looks like.

## First: does the host have a countable surface?

This is the question to settle before writing any code, because it decides whether the
contribution is a row, a full integration, or a polite no.

A surface counts when it is **persistent** and **host-owned**:

- **Persistent** — it stays on screen rather than appearing for a moment. A toast that fades
  after three seconds was not read by anyone in particular.
- **Host-owned** — the host renders it as part of its own chrome, in a documented slot meant
  for this. Text the model happens to print is not a surface; it is output, and it can be
  anything on the next run.

Codex is the worked example of failing this bar, and it is in the table anyway. Its reachable
places are a warning cell, an Enterprise-only push field, the model's own plan output, and a
thread title. None is both persistent and host-owned, so none is a countable impression — the
row carries `surface: null` and `obrigado install --agent codex` is accepted *specifically so
it can be refused with the reason and a non-zero exit*, rather than answering "Unsupported
agent" to somebody who asked about something real.

So a host with no countable surface is still worth a row. It is not worth an integration.

If you are unsure, open an issue describing the slot — where it renders, whether the host
documents it, and how long it stays — before building anything. That conversation is cheaper
than a rejected PR, and the answer usually turns on a detail of the host that only somebody
who uses it knows.

## The row

Every list of hosts in this codebase is derived from one table:
`packages/shared/src/agents.ts`. Adding a host is one row.

```ts
{
  id: "example",
  label: "Example",
  installs: "cli",
  kind: "terminal",
  surface: "The status line, configured by the documented `statusLine` settings key.",
  inherits: null,
},
```

| Field | What it means |
|---|---|
| `id` | The wire value. It becomes a rollup key on the server, so it is **append-only in practice**: a name that has ever been reported has to keep resolving even after nothing installs it. Lowercase, hyphenated, matching what the host calls itself. |
| `label` | What the host calls itself, because that is what a reader scans for. |
| `installs` | `"cli"` if `obrigado install` owns the installer, `"marketplace"` if the host's own extension gallery does, `null` if nothing installs it yet. |
| `kind` | `"terminal"` or `"editor"`. Editors are detected and polled differently — an editor window is visible whether or not an agent is running in it, which changes how viewability is judged. |
| `surface` | One sentence, in the host's own vocabulary, naming the documented slot. `null` when the host has none that counts. This sentence is printed under the demo on the website, so write it for a reader. |
| `inherits` | The host whose surface this one reuses, when it is a fork rather than its own program. Cursor is a VS Code fork running the same extension unchanged, so it inherits `vscode`. It keeps a separate `id` because the impression records which one rendered. |

A row may not both `inherit` a surface and declare one. A fork does not have a surface; it
shows somebody else's.

## What the compiler will then demand

The four lists that used to be maintained by hand are now `AGENTS.filter(...)`, so they update
themselves. What does not update itself is the per-host behaviour, and that is deliberate:
every site is an exhaustive `Record` keyed by the agent id, so adding a row with
`installs: "cli"` fails the build until each one is filled in.

Adding an `installs: "cli"` row produces exactly three errors, and they are your checklist:

```
packages/client/src/commands/install.ts: Property 'example' is missing in type
  '{ … }' but required in type 'Record<…, () => boolean>'.          ← DETECTORS
packages/client/src/commands/install.ts: … required in type
  'Record<…, (config: ClientConfig) => boolean>'.                    ← INSTALLED_CHECK
packages/client/src/commands/install.ts: … required in type
  'Record<…, Remover>'.                                             ← REMOVERS
```

- **`DETECTORS`** — is the host present on this machine? Usually a config directory or a
  binary on `PATH`.
- **`INSTALLED_CHECK`** — given our config, are we already installed into it? This is what
  makes `install` idempotent and `uninstall` honest.
- **`REMOVERS`** — undo the install completely. A remover that leaves a dangling settings key
  behind is the reason somebody's status line breaks two versions later.

A `marketplace` row does not touch these, because the host's gallery owns installation.

## The tests that fail on purpose

Adding a row also fails several tests in `packages/shared/test/agents.test.ts`, and this is
intended rather than a bug in your change. Each one pins a derived view to an exact set:

- `names every host it knows about`
- `installable is what \`obrigado install --agent\` accepts`
- `surfaced is what the landing page can honestly demo`
- `editors are the hosts polled as editors`

They exist because the table drives four consumers that cannot see each other, and a silent
change to any view is the failure this table was built to prevent. Update the ones your row
belongs in. If your row changes a list you did not expect, that is worth understanding before
you edit the expectation — it usually means a field is set wrong.

## Choosing an integration

The host decides this, not us. There are three precedents:

1. **The host calls a command.** Claude Code is configured to run `obrigado statusline`, and
   the client prints one line to stdout. This is the simplest case and the one to copy when
   the host supports a status-line command. See `packages/client/src/commands/statusline.ts`.
2. **The host loads a plugin.** OpenCode registers `@obrigado/opencode-plugin/tui` in its own
   `tui.json`, and the plugin renders into the host's `app_bottom` slot. Copy this when the
   host has a plugin API. See `packages/opencode-plugin/`.
3. **The host has an extension gallery.** VS Code and Cursor install an extension that creates
   a status bar item. See `packages/vscode-extension/`.

Whichever applies, the rendering rules — the `sponsored` label, the allowed styles, the
control-character ban — live in `packages/shared` and are not per-host. Do not reimplement
them; a surface that renders ad copy without the disclosure is not a surface we can ship.

## Before you open the PR

```sh
bun install --frozen-lockfile
bun run check
```

`check` runs lint, formatting, types, and tests. All four must pass.

A good surface PR contains: the row, the per-host behaviour the compiler asked for, the
integration, tests for the parts that can go wrong on a machine that is not yours, and a
sentence in the PR description saying **which documented slot** the host renders into. That
last one is what a reviewer cannot look up.
