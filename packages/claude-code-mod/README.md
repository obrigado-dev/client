# Obrigado for the Claude desktop app

A Claude Code mod that draws the sponsored line in the Claude desktop app's Code tab, where
Claude Code has no status line. It reports impressions as the agent `claude-desktop`. The
platform's SPEC-AMENDMENTS A37 is the decision and its reasoning.

Claude Code v2.1.287 made [mods](https://code.claude.com/docs/en/plugins/mods/overview)
generally available: plugins whose code Claude Code calls as it runs, including each time it draws
its own interface. This one draws the sponsored line in the band directly above the prompt, the
documented `AbovePrompt` render site.

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
  nobody saw. The status line cannot be collapsed.
- **The app's band has no way to collapse it**, as of 2.1.288.

So the mod asks for a line only in a session that draws in the app and in no terminal
(`$.session.surfaces()`). A terminal session the app has attached to is still the terminal's.

Like every other host, it draws and does not deliver. It runs
`obrigado statusline --agent claude-desktop --json` every thirty seconds and draws the parts it is
handed with Claude Code's own elements: the label as plain text, the brand's square icon as an
`Svg` (the app's only picture element, drawn as an image with scripts stripped) one line high and
sized from the PNG's own header, and the copy as one `Link` to the click URL. The icon is
`brand.icon` on the wire: uploaded in the advertise form or on the account page, or taken from
the click URL's favicon.

## Timing

Claude Code hands its status line `cost.total_duration_ms` and `cost.total_api_duration_ms`, and
the classifier reads the difference as a person's time. The mods API hands a hook neither, so the
mod keeps both (`hooks/timing.ts`): the wall clock from its own `session.start`, and each model
request's time in flight, measured around `turn.step`. It hands them to the renderer in the
status line's own fields, so nothing on that side knows they came from a mod.

The app runs Claude Code with no terminal, so the renderer does not ask for one there: `tty` is
left out rather than reported as `false`, and the classifier lets the app stand where a terminal
would.

## What is accepted rather than solved

- **A mod earlier in the chain can drop our row** after the renderer has counted it.
- **The app's band staying uncollapsible was seen, not promised.** A version that adds a way to
  hide it puts the terminal's problem back, and
  [anthropics/claude-code#98986](https://github.com/anthropics/claude-code/issues/98986) is the
  request for a mod to be told.

## Installing

```sh
obrigado install --agent claude-desktop
```

A plain `obrigado install` does the same where the app's Code tab has been used. It writes three
entries in `~/.claude/settings.json`: the `obrigado` marketplace (this repository's root) with
Claude Code's auto-update on, the `obrigado@obrigado` plugin enabled, and the renderer's full path
as `OBRIGADO_STATUSLINE_COMMAND`.
The path is spelled out because the app starts Claude Code with the `PATH` the app was started
with, which for an app opened from the Dock may not be your shell's. Claude Code fetches the
plugin itself once the app's next session starts. `obrigado uninstall --agent claude-desktop`
turns it off.

## Developing

Load this folder in place rather than from the marketplace, which installs the released tag:

```sh
claude --plugin-dir packages/claude-code-mod
```

For the app, which takes no flags, set `CLAUDE_CODE_PLUGIN_DIRS` to this folder's absolute path in
the `env` block of `~/.claude/settings.json`, and `OBRIGADO_STATUSLINE_COMMAND` to a renderer the
app can run. Sessions that were already open keep the plugins they started with until
`/reload-plugins`.

To see what the mod reads and calls without running it:

```sh
claude plugin validate packages/claude-code-mod
```

The `calls:` line is the whole list: the clock, one environment variable, `$.process.run`, the
session's id, directory and surfaces, and drawing. No prompt, tool call or transcript is read.

`hooks/surface.ts` is a copy of `@obrigado/surface`, because a hooks module can import only files
inside the plugin. A test fails if the two differ.

## Releasing

The marketplace pins the plugin to the tag `claude-code-mod-v<version>`, so what installs is what
was released and nothing pushed since. A release bumps the version in `package.json`,
`.claude-plugin/plugin.json`, `SURFACE_VERSION` in `hooks/register.ts` and the `ref` in the root
`.claude-plugin/marketplace.json` together (`manifest.test.ts` holds all four to each other), then
pushes the commit and its tag at once:

```sh
git tag claude-code-mod-v<version>
git push --atomic origin main claude-code-mod-v<version>
```

Pushing the commit without the tag leaves the marketplace naming a tag that does not exist, and
every install fails until it does.

Installs then update by themselves: the installer turns on Claude Code's auto-update for this
marketplace (A38), so within about ten minutes of a session's first message Claude Code fetches the
new tag, says "Plugin updated: obrigado", and loads it at the next launch.
