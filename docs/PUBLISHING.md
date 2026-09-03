# Publishing

The packages here are published to npm under the `@obrigado` scope. This is the whole of how,
because Bun's tooling differs from pnpm's in a few places worth writing down once.

## Bun's equivalents

| pnpm | here |
|---|---|
| `pnpm login` | `npm login` — Bun has no login command; `bun publish` reads the token `npm login` writes to `~/.npmrc` (or `NPM_CONFIG_TOKEN`) |
| `pnpm whoami` | `bun pm whoami` |
| `pnpm version 0.1.0` | `bun pm version 0.1.0 --no-git-tag-version` — see tags below |
| `pnpm pack` | `bun pm pack` — rewrites `workspace:*` to the exact version, runs `prepack` |
| `pnpm publish` | `bun publish --access public` — same rewrite, same lifecycle scripts |

`bun pm version` without `--no-git-tag-version` creates a plain `v<version>` tag, which is the
binaries' tag namespace. Packages tag as `<package>-v<version>`, by hand.

## Order

`@obrigado/surface` first. The OpenCode plugin depends on it, and packing turns that
`workspace:*` into the exact version in surface's manifest, so the surface version the plugin
names has to exist on the registry before anyone installs the plugin. The VS Code extension
bundles surface at build time and never touches the registry.

## The first version of a package

By hand, from a laptop. npm's trusted publishing can only be configured on a package that
already exists, so version one is a token publish. Pack with bun and publish with npm:
`bun publish` cannot complete npm's browser authentication step (Bun 1.3.10 polls
`/-/v1/done`, gets a 404, reports the package as missing and exits 0 without publishing),
and `npm publish` does not rewrite `workspace:*`, so each does the half it can.

```sh
npm login                                  # once; writes ~/.npmrc
cd packages/surface
bun pm pack --destination dist/npm         # runs prepack (the build); prints what ships
npm publish dist/npm/*.tgz --access public # approve the URL it prints
git tag surface-v0.1.0 && git push --tags  # the record of what went out
```

Provenance is CI-only (`--provenance` in the workflow), so it is not in `publishConfig`;
npm refuses to publish from a laptop when it is.

Then, on npmjs.com, open the package → Settings → Trusted publishing, and add this repository
(`obrigado-dev/client`) with workflow `publish.yml`. Every later version goes through CI.

## Every later version

1. Bump the manifest: `cd packages/<pkg> && bun pm version <version> --no-git-tag-version`.
2. Commit, then tag `<pkg>-v<version>` on that commit and push the tag.
3. `.github/workflows/publish.yml` runs the gate, packs with bun, publishes with npm and
   `--provenance`, and refuses if the tag's version is not the manifest's.

`workflow_dispatch` on the same workflow publishes a package by name, for a re-run or a
`next` dist-tag.

## What ships

Each publishable package lists its files explicitly (`files` in `package.json`), and
`bun pm pack --dry-run` prints exactly that list. Surface ships its source (the `bun` export
condition, which is what OpenCode resolves), a bundled `dist/index.js` for Node, and
`dist/index.d.ts` for TypeScript. Anything not on the list — tests, tsconfig, build state —
does not go.
