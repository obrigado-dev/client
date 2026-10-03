# Obrigado for Claude Code, as a mod

**Parked.** This works, and it is kept working: the client's gate lints, typechecks and tests it.
It is not shipped yet, for the reasons below.

Claude Code v2.1.287 made [mods](https://code.claude.com/docs/en/plugins/mods/overview)
generally available: plugins whose code Claude Code calls as it runs, including each time it draws
its own interface. This one draws the sponsored line in the band directly above the prompt, the
documented `AbovePrompt` render site, in the Claude desktop app's Code tab.

```
oss-sponsor · ● Acme DB: serverless Postgres, branching included
───────────────────────────────────────────────────────────────
❯
```

## The app, not the terminal

It draws in the app and nowhere else; the terminal keeps the status line. A session shows one
line, from whichever surface can count it honestly:

- **The terminal's band can be collapsed** (`ctrl+x ctrl+a`, or its `[-]`), and Claude Code goes
  on asking a collapsed band to draw with the same props, so a line counted there may be a line
  nobody saw. The status line cannot be collapsed, and it carries the turn timing the
  classifier reads.
- **The app's band has no way to collapse it**, as of 2.1.288.

So the mod asks for a line only in a session that draws in the app and in no terminal
(`$.session.surfaces()`). A terminal session the app has attached to is still the terminal's.

Like every other host, it draws and does not deliver. It runs
`obrigado statusline --agent claude-code-mod --json` every thirty seconds and draws the parts it is
handed with Claude Code's own elements: the label as plain text, the brand's square icon as an
`Svg` (the app's only picture element, drawn as an image with scripts stripped) one line high and
sized from the PNG's own header, and the copy as one `Link` to the click URL. The icon is
`brand.icon` on the wire: uploaded in the advertise form or on the account page, or taken from
the click URL's favicon. Seen working in the app on 2026-10-03, mark included.

## Try it

You need Claude Code v2.1.287 or later, the desktop app, and an `obrigado` the app can run.

```sh
# From the client repository.
claude plugin marketplace add ./prototypes
claude plugin install obrigado@obrigado-prototypes --scope user
```

Then start a new local session in the app's Code tab. Sessions that were already open keep the
plugins they started with until `/reload-plugins`. The app runs `obrigado` from the `PATH` it was
started with, which for an app opened from the Dock may not be your shell's.

To take it out again:

```sh
claude plugin uninstall obrigado@obrigado-prototypes --scope user
claude plugin marketplace remove obrigado-prototypes
```

To see what the mod reads and calls without running it:

```sh
cd prototypes/claude-code-mod && claude plugin validate .
```

The `calls:` line is the whole list: the clock, one environment variable, `$.process.run`, the
session's id, directory and surfaces, and drawing. No prompt, tool call or transcript is read.

## Why it is not a surface yet

- **A mod earlier in the chain can drop our row** after the renderer has counted it.
- **No turn timing.** Claude Code gives its status line `cost.total_duration_ms` and
  `cost.total_api_duration_ms`; the mods API has neither, so these impressions reach the
  classifier without the signal the status line's carry.
- **The app's band staying uncollapsible was seen, not promised.** A version that adds a way to
  hide it puts the terminal's problem back, and
  [anthropics/claude-code#98986](https://github.com/anthropics/claude-code/issues/98986) is the
  request for a mod to be told.

`hooks/surface.ts` is a copy of `@obrigado/surface`, because a hooks module can import only files
inside the plugin. A test fails if the two differ.

## Picking it up

1. Make the renderer refuse an `--agent` it does not know. Today it falls back to `claude-code`
   (pinned in `codex-statusline.test.ts`), so an older `obrigado` would bill this mod's lines to
   the status line and run the developer's chained status-line command.
2. Consider renaming the agent to what rendered, the app (`claude-desktop` is Claude Code's own
   name for it). Nothing has reported `claude-code-mod` yet, so the rename is still free.
3. Move the directory to `packages/`, so it is a workspace, and update the two `tsconfig.json`
   references and this README's paths. Add it to `PUBLISHED_SHIMS` in
   `packages/client/test/surface-versions.test.ts` and to the platform's `knip.json`.
4. In `packages/shared/src/agents.ts`, give the row its installer and its surface sentence.
5. Check that the app finds `obrigado` on the `PATH` it starts with.
