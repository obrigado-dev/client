# Obrigado client

This repository contains the source for the developer-installed parts of
[Obrigado.dev](https://obrigado.dev):

- the `obrigado` CLI and status-line integrations;
- the shared wire contract and rendering rules;
- the OpenCode plugin;
- the VS Code and Cursor extension.

This is where that code is developed. The private
[`obrigado-dev/platform`](https://github.com/obrigado-dev/platform) repository holds the
services — auction, settlement, ledger, the website — and depends on this one, pinned to a
commit. Changes here arrive there when that pin moves.

It used to be the other way round: this repository was an export, rewritten wholesale on
every commit to platform, which meant a merged pull request here was reverted by the next
sync. That is gone. A change landed here stays landed, and releases are built from commits
visible in this history.

New coding agents and terminals appear constantly, and adding support for one is the most
self-contained change this repository takes. [Adding a surface](./docs/ADDING-A-SURFACE.md)
covers what counts as a surface, the one row that declares a host, and the per-host behaviour
the compiler will ask you for.

## Development

Requires Bun 1.3.10 or newer.

```sh
bun install --frozen-lockfile
bun run check
bun run package:vscode
```

## Supply chain

Bun refuses to resolve direct or transitive package versions published less than seven days
ago. Known vulnerabilities fail the OSV-Scanner workflow, and the dependency audit also
runs daily so newly published advisories are detected even when the source has not changed.
The scanner downloads the public advisory database and matches `bun.lock` locally; it does
not send the dependency inventory to OSV or npm.

## License

The exported client source is licensed under the
[Apache License 2.0](./LICENSE).
