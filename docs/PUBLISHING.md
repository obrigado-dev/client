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
(`obrigado-dev/client`) with workflow `publish.yml`. Check "Allow `npm publish`": the workflow
publishes directly. Every later version goes through CI.

## Every later version

1. Bump the manifest: `cd packages/<pkg> && bun pm version <version> --no-git-tag-version`.
   Then bump the same package's `"version"` in `bun.lock` by hand — `bun install` leaves it,
   and packing pins dependents from it. `version.test.ts` holds the two together.
2. Commit, then tag `<pkg>-v<version>` on that commit and push the tag.
3. `.github/workflows/publish.yml` runs the gate, packs with bun, and publishes the version
   with `npm publish --provenance`. It refuses if the tag's version is not the manifest's.

There is no approval step: the tag is the release. Until 2026-10-03 the workflow staged each
version with `npm stage publish` and a maintainer approved it with 2FA, so that a compromised
workflow or a stray tag could not ship on its own. That was dropped as friction on every
release; what stands in for it now is the gate, the tag having to match a committed version,
and the provenance attestation on each version.

`workflow_dispatch` on the same workflow publishes a package by name, for a re-run or a
`next` dist-tag.

## What ships

Each publishable package lists its files explicitly (`files` in `package.json`), and
`bun pm pack --dry-run` prints exactly that list. Surface ships its source (the `bun` export
condition, which is what OpenCode resolves), a bundled `dist/index.js` for Node, and
`dist/index.d.ts` for TypeScript. Anything not on the list — tests, tsconfig, build state —
does not go.

## The CLI on npm (A44)

`npm install -g @obrigado/client`, or pnpm's, bun's or yarn's equivalent, installs the release
binaries through six packages, all at the CLI's version:

- `@obrigado/client-darwin-arm64`, `-darwin-x64`, `-linux-arm64`, `-linux-x64` and
  `-linux-x64-musl`. Each is the release's `obrigado-<platform>`, byte for byte, as `bin/obrigado`,
  and declares the `os`, `cpu` and `libc` it runs on.
- `@obrigado/client`. It names all five as optional dependencies at that exact version, so a
  package manager installs the one that fits. Its `bin/obrigado` is
  `packages/client/npm/obrigado.sh`, a POSIX shell script that finds that package and runs its
  binary. It is shell because agents run it on every render, some with no node on their PATH.

Windows is not among them (A46). Every Windows package manager runs a package's `bin` through the
`/bin/sh` its first line names, which Windows lacks, and `bin` is one file on every system, so the
release's Windows builds stay on GitHub, for install.ps1. `@obrigado/client` declares `os` darwin
and linux so npm says so on Windows by name, and `scripts/npm-packages.ts` refuses a release target
that is neither published nor in `NOT_ON_NPM`.

`packages/client/src/npm-packages.ts` describes them, and `scripts/npm-packages.ts` lays them out
from a release's assets. `packages/client/package.json` stays private: it is the checkout's
manifest, whose `bin` is `src/cli.ts`, and not what npm gets.

Every `v<version>` release publishes them. `release.yml`'s `npm` job runs after the GitHub
release: it downloads what was published, checks it against the signed SHA256SUMS, lays the
packages out, and publishes them with `npm publish --provenance`: the platform packages first,
then `@obrigado/client` once npm serves every one of them, since it names each at its exact
version and npm took over ten minutes to make 0.3.11's linux-x64 pair installable. A version
already on the registry is skipped, so a failed job is re-run alone.

An npm install updates itself like any release binary (A38): the daily check replaces the binary
where the package manager put it. `npm ls -g` goes on naming the version installed until the next
`npm install -g @obrigado/client@latest`, which lays the same bytes down.

`obrigado install` from an npm install writes each host's command with the full path of the
`obrigado` it found on PATH, not the bare name (0.3.12). Under a Node version manager such as
nvm, fnm or Vite+ that bin directory belongs to one Node version, and the bare name would stop
resolving in any shell on another one.

### Their first version

By hand, once, because trusted publishing can be set up only on a package that exists. 0.3.11 went
out this way. From this repository, with npm 11.15 or later and 2FA on the account:

```sh
mkdir -p dist/release && cd dist/release
gh release download v0.3.11 --repo obrigado-dev/client --pattern 'obrigado-*' \
  --pattern editors.json --pattern SHA256SUMS --pattern SHA256SUMS.sig
shasum -a 256 -c SHA256SUMS && bun ../../scripts/sign-release.ts --verify . && cd ../..
bun scripts/npm-packages.ts dist/release dist/npm
for dir in ./dist/npm/client-* ./dist/npm/client; do npm publish "$dir" --access public; done
for name in client client-darwin-arm64 client-darwin-x64 client-linux-arm64 client-linux-x64 \
  client-linux-x64-musl; do
  npm trust github "@obrigado/$name" --file release.yml --repo obrigado-dev/client --allow-publish --yes
done
```

`npm trust` is the CLI form of the package's Settings → Trusted publishing on npmjs.com. A package
added later, such as a new platform, needs the same two steps before the release that names it.

## The editors (A40)

Not npm. Every `v<version>` release carries both editor builds beside the binaries, stamped with
the release's version by `scripts/build-editors.ts`: `obrigado-vscode-<v>.vsix`,
`obrigado-jetbrains-<v>.zip`, and `editors.json`, which names them and the JetBrains plugin's
since/until builds. All three are in SHA256SUMS before it is signed. Both manifests stay `0.0.0`
in the repository; a release is the only thing that gives either a version.

- **VS Code, Cursor, Antigravity IDE and Kiro** install the `.vsix` through
  `obrigado install --agent vscode|cursor|antigravity-ide|kiro`,
  which checks it against the signed checksums and runs the editor's own `--install-extension`,
  and the daily background update installs the next one. By hand: the release's `.vsix`, or
  https://obrigado.dev/vscode/obrigado.vsix, then **Extensions: Install from VSIX…**.
- **JetBrains IDEs** install through `obrigado install --agent jetbrains`, which checks the
  release's zip against the signed checksums, keeps it in a repository at `~/.obrigado/jetbrains`,
  runs each closed IDE's own `installPlugins` against that, and adds it to the IDE's
  `idea.plugin.hosts`; the daily update puts the next release's checked zip there (A43). By hand,
  unchecked: add https://obrigado.dev/jetbrains/updatePlugins.xml, whose feed is built from the
  latest release's `editors.json`, under **Settings → Plugins → ⚙ → Manage Plugin Repositories**,
  then install from the Marketplace tab.

Before a release that changes the JetBrains plugin, run `./gradlew verifyPlugin` in
`packages/jetbrains-plugin`: the Plugin Verifier checks the build against the recommended IDE
releases, which neither CI nor the release does because it downloads several of them.

The stores are still worth listing on, and nothing here changes when they do. The VS Code
Marketplace and Open VSX need the `obrigado` publisher claimed. The JetBrains Marketplace needs a
vendor profile, a first upload by hand, and JetBrains' review, whose guidelines exclude "features
for additional promotion"; a reviewer may read a sponsored line that way, so that listing is not
a given.

## Chrome extension

The Chrome extension has its own version in `packages/browser-extension/package.json` and
tags `browser-extension-v<version>`. It is private on npm. `browser-release.yml` runs the
client gate and Chromium smoke test, builds the WXT ZIP, checks its embedded manifest for the
tagged version and production API permission, and creates a GitHub release with a SHA-256
checksum. Browser releases use `--latest=false`: the CLI updater must keep finding the CLI's
latest release. Existing release assets are kept; a submission retry downloads those original
bytes and verifies their checksum and manifest.

### First release: manual store submission

1. Deploy the platform's browser API before making the extension available. Test all four
   authenticated provider layouts; the automated tests use controlled provider fixtures.
2. Commit and push the client changes, then tag that commit `browser-extension-v0.1.0` and
   push that specific tag. With `CHROME_EXTENSION_ID` unset, the workflow creates the GitHub
   ZIP release and explicitly skips store submission. Download its ZIP for the next step.
3. Register a Chrome Web Store developer account, enable two-step verification, and create
   the extension listing in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole).
   Upload the ZIP, complete the listing, screenshots, permissions and privacy disclosures,
   link the public extension privacy policy, and submit for review. The listing and privacy
   policy must match the extension's popup and actual behaviour.
4. Save the assigned extension ID and publisher ID. Finish the initial manual publication,
   then configure the service account below. WXT cannot create the first listing. Google
   reviews updates too; a successful CI submission means submitted, not approved.

### One-time setup for automatic updates

The workflow uses WXT's Chrome Web Store **v2** publisher and a short-lived service-account
access token from GitHub OIDC. It stores no service-account key or OAuth refresh token.

1. In a Google Cloud project, enable the Chrome Web Store API and IAM Service Account
   Credentials API. Create a dedicated service account, then add its email under Account
   in the Chrome Web Store Developer Dashboard. This grants access to the publisher's items.
2. Follow Google's [Workload Identity Federation through a service account](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account)
   setup. Use `https://token.actions.githubusercontent.com` as issuer and map
   `google.subject=assertion.sub`, `attribute.repository=assertion.repository` and
   `attribute.workflow_ref=assertion.workflow_ref`. Restrict the provider with this condition:

   ```text
   assertion.repository == 'obrigado-dev/client' && assertion.workflow_ref.startsWith('obrigado-dev/client/.github/workflows/browser-release.yml@refs/tags/browser-extension-v')
   ```

   Grant `roles/iam.workloadIdentityUser` on that service account to
   `principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/attribute.repository/obrigado-dev/client`.
   The auth action requests only the `https://www.googleapis.com/auth/chromewebstore` scope.
3. Add these **repository Actions variables** in `obrigado-dev/client`:

   | Variable | Value |
   |---|---|
   | `CHROME_WORKLOAD_IDENTITY_PROVIDER` | Full provider resource: `projects/…/locations/global/workloadIdentityPools/…/providers/…` |
   | `CHROME_SERVICE_ACCOUNT` | The dedicated service-account email |
   | `CHROME_PUBLISHER_ID` | Publisher → Settings in the store dashboard |
   | `CHROME_EXTENSION_ID` | The existing store item's ID; set this last to enable submission on future tags |

4. Verify access without uploading or submitting anything. Dispatch on the existing **tag**
   so the OIDC workflow identity matches the provider condition:

   ```sh
   gh workflow run browser-release.yml --repo obrigado-dev/client \
     --ref browser-extension-v0.1.0 \
     -f tag=browser-extension-v0.1.0 -f operation=check
   ```

### Later releases

1. Bump the browser manifest's package version to a three-part numeric version (for example,
   `0.1.1`), and update its workspace version in both client and platform `bun.lock` files.
2. Run the client gate and the platform's full E2E suite, commit and push the client first,
   then update the platform pin and deploy any required server change.
3. Tag the client release commit `browser-extension-v0.1.1` and push that specific tag. The
   workflow runs the gate and browser smoke, publishes the ZIP release, then uses `wxt submit`
   to upload and submit the update for Google's review. It publishes automatically after
   approval. It does not cancel an existing review or bypass review.

The workflow also accepts manual `operation=package` (GitHub ZIP only), `check` (store
authentication only), or `submit` (upload and request review), with an existing browser tag.
For `check` or `submit`, pass `--ref` with the same tag as `-f tag=…`. A missing store variable
fails an explicit check or submission. If the upload or submission already reached Google,
check the Developer Dashboard before retrying: Chrome rejects re-uploading the same version.
The workflow does not cancel a review or overwrite a GitHub release to recover from that.

References: [WXT publishing](https://wxt.dev/guide/essentials/publishing.html),
[WXT submit options](https://wxt.dev/api/cli/wxt-submit),
[Chrome API setup](https://developer.chrome.com/docs/webstore/using-api),
[Chrome service accounts](https://developer.chrome.com/docs/webstore/service-accounts).
