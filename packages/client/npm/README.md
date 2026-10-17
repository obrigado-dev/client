# obrigado

One sponsored line in your coding agent's status bar, and 70% of what it earns paid to the open
source maintainers of the packages you use. You pay nothing and earn nothing.
[obrigado.dev](https://obrigado.dev)

## Install

```sh
npm install -g @obrigado/client   # or pnpm add -g, bun add -g
obrigado install
```

`obrigado install` connects your coding agents. Without Node,
`curl -fsSL https://obrigado.dev/install.sh | sh` installs the same binary.

On Windows this package does not install: from PowerShell,
`irm https://obrigado.dev/install.ps1 | iex` installs the Windows build of the same release.

## What this package is

`@obrigado/client` is a short shell script, `bin/obrigado`, and one optional dependency per
platform: `@obrigado/client-darwin-arm64`, `-darwin-x64`, `-linux-arm64`, `-linux-x64` and
`-linux-x64-musl`. Your package manager installs the one that fits the machine and the script
runs it. Windows has a build, but not on npm: a package manager there would run this script
with a `/bin/sh` Windows does not have.

Each holds the binary of the matching GitHub release, byte for byte. Its SHA-256 is the
`obrigado-<platform>` line of that release's `SHA256SUMS`, which is signed (`SHA256SUMS.sig`,
Ed25519).

## Updates

The binary keeps itself current, as one installed with install.sh does. At most once a day it
fetches the latest release, checks it against the signed checksums, replaces itself where it is,
and says so in the line. Your package manager goes on listing the version you installed until you
update through it, which puts the same bytes back. `obrigado config auto_update false` turns the
self-update off.

Source: [obrigado-dev/client](https://github.com/obrigado-dev/client). Apache-2.0.
