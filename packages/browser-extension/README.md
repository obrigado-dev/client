# Obrigado for Chrome

**Coming soon to the Chrome Web Store.** The code and local development builds are available;
the store listing is pending publisher verification and review.

One WXT extension for Chrome 123+, with local adapters for Claude, ChatGPT, DeepSeek and Replit. It adds its own
labelled status line beside the composer after a real interaction. It never replaces the native
spinner, send button, stop button, model output or advertisements.

```sh
bun install --frozen-lockfile
bun run build:browser
bun run package:browser
```

From this workspace's root, load `packages/browser-extension/.output/chrome-mv3` through
Chrome's **Extensions → Developer mode → Load unpacked**, then open Obrigado's popup and choose
**Agree and enable Obrigado**. Reload an already-open chat tab once after installation. For
development, run `bun run --cwd packages/browser-extension dev`.

The provider adapters have controlled DOM fixtures; authenticated testing against each live
provider is required before a store release. Provider DOM is not a documented integration API,
so changes to a composer may require an extension update. An unrecognised layout shows nothing.

See [the design and limitations](../../docs/BROWSER-EXTENSION.md).

Releases use `browser-extension-v<version>` tags and
[the browser release workflow](../../.github/workflows/browser-release.yml). The first Chrome
Web Store submission is manual; subsequent updates use WXT with Chrome API v2 and GitHub OIDC.
See [the release and account setup](../../docs/PUBLISHING.md#chrome-extension).
