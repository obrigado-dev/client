# Working in this repository

`README.md` is the map. `docs/ADDING-A-SURFACE.md` is how a new host gets a status line.
`docs/PUBLISHING.md` is the long form of the release section below.

## The gate

`bun run check` runs lint, format, types and tests; the pre-push hook runs it, and CI runs it
plus `bun run package:vscode`. A change is not done until it passes.

Tests and scripts that spawn the real renderer must strip the CI variables from the child's
environment (`CI_VARIABLES` in `packages/client/src/api.ts`, see `test/chain-order.test.ts`),
because the renderer withholds the sponsored line under any CI system by design. Forgetting
this passes on every laptop and fails on every runner.

## Releasing

### What ships from where

| What | Where it goes | How | State |
|---|---|---|---|
| `@obrigado/surface` | npm | tag `surface-v<version>` → `publish.yml` stages → a person approves | 0.1.0 published |
| `@obrigado/opencode-plugin` | npm | same, once it is no longer `private` | unpublished; pins surface's exact version |
| `obrigado` CLI binaries | GitHub Releases, fetched by `install.sh` | tag `v<version>` → `release.yml` | unreleased |
| VS Code / Cursor extension | Marketplace | `bun run package:vscode` → `.vsix` | publisher `obrigado` unclaimed |
| Pi extension | copied into `~/.pi/agent/extensions` by the CLI | ships inside the CLI | n/a |

### A new version of an npm package

1. Bump: `cd packages/<pkg> && bun pm version <version> --no-git-tag-version`. Never plain
   `bun pm version`: it creates a `v*` tag, which is the binaries' namespace.
2. Commit. Tag that commit `<pkg>-v<version>`. Push the branch, then the tag.
3. `.github/workflows/publish.yml` runs the gate, packs with `bun pm pack` (which rewrites
   `workspace:*` to the exact version and runs `prepack`, the build), and **stages** the
   version with `npm stage publish --provenance` through npm trusted publishing. It refuses if
   the tag's version is not the manifest's. It cannot publish directly: the trusted publisher
   on npmjs.com allows staging only, so a compromised workflow or a stray tag cannot ship a
   release by itself.
4. A maintainer approves from a laptop, with 2FA: `npm stage list @obrigado/<pkg>`, then
   `npm stage approve <stage-id>` (or the package page on npmjs.com). Nothing is public until
   this step. **An agent cannot do this step; ask the user to.**
5. Re-running a tag whose version is already public is a no-op. One that is staged but not yet
   approved fails with "already staged": approve or reject it first.

### The first version of a new package

By hand, from a laptop, because trusted publishing can only be configured on a package that
already exists:

```sh
cd packages/<pkg>
bun pm pack --destination dist/npm          # prints exactly what will ship
npm publish dist/npm/*.tgz --access public  # the USER runs this: it opens a browser auth step
```

Then the user adds the trusted publisher on npmjs.com: repository `obrigado-dev/client`,
workflow `publish.yml`, and "Allow `npm publish`" left unchecked.

Things that look like shortcuts and are not:
- `bun publish` cannot complete this account's browser authentication (Bun 1.3.10 polls
  `/-/v1/done`, gets a 404, reports the package as missing and exits 0 without publishing).
- `npm publish` on a folder does not rewrite `workspace:*`; pack with bun first.
- `--provenance`, or `provenance: true` in `publishConfig`, fails outside CI.
- npm's index can lag a published version by minutes; "404 after publish" is usually that.

### Order

Surface before the OpenCode plugin: packing pins the plugin to surface's exact version, so
that version must be public first. The VS Code extension bundles surface at build time and
never touches the registry. Each package lists what it ships in `files`; nothing outside that
list goes.

### Binaries

A `v<version>` tag runs `release.yml`: the gate, `bun run build:binaries` for every platform,
a GitHub release with `SHA256SUMS`, and a download-and-verify of what was published.

## The platform pin

This repository is a git submodule of `obrigado-dev/platform`, pinned by commit. After a
commit here: push here first, then in the platform `git add client && git commit -m "Pin the
client at <what changed>"` and push. The other order leaves the platform's CI unable to
resolve the pin.
