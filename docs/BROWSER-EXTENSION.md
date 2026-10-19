# The browser surface

One Chrome Manifest V3 extension, built with WXT 0.21.4. The first adapters target `claude.ai`,
`chatgpt.com`, `chat.deepseek.com` and `replit.com`. Adding a provider is an adapter change inside
the same extension, with an explicit domain permission and a tested composer selector.

## What changed since the spinner discussion

The original limitation was Claude Code's static `spinnerVerbs` setting: it has no display
callback, and reaching the spinner required patching program files (platform amendment A1).
That is not a limitation of a Chrome content script observing an element it created. It also
does not make the provider's spinner a supported extension point.

This extension adds an independent, attributed line adjacent to a recognised composer. It
does not change the provider's working indicator or controls. This is an explicit exception
to the terminal surface guide's requirement for a documented host-owned slot: Chrome supplies
the documented extension API; the provider supplies no supported composer slot. Selector
maintenance and possible provider blocking are real ongoing costs.

## Delivery and counting

The WXT background worker loads `@obrigado/client/browser`, the browser runtime of the client.
It shares rotation, disclosure and text sanitising with the terminal renderer. Content scripts
receive presentation parts and an impression id, never an install key or a billing nonce.
They create DOM nodes inside WXT's shadow-root UI; ad copy is never HTML or executable code.

The server's `/api/v1/browser/session` accepts only the extension version, derives an empty
dependency inventory and disables every sharing dimension. Delivery then uses the existing
auction, budget reservations, signed click URLs, nonce store, beacon ingestion, ledger and
grants pool. A36 already replaced per-package payouts with grants, so a lockfile is unnecessary.
No new database schema or payout path is needed.

An impression requires at least half the line to be visible and unoccluded for one continuous
second, in a visible, focused tab, within five minutes of a trusted interaction with the
composer. Losing focus or visibility resets the exposure clock. SPA navigation resets local
attention. A creative holds its slot for thirty seconds. Multiple tabs share one rotation
and queue, and nonces prevent duplicate billing. The server rejects inadequate browser
exposure before the billable `unknown` measurement bucket can be reached.
A signed sponsor-link click can also confirm a displayed line through the existing click path,
as it does on the other surfaces; it is itself post-render evidence of attention.

Queue state and reported ids are persisted together. Worker restarts and transient failures
retry with backoff, within the existing nonce lifetime. Pausing stops new delivery, drops the
pending queue, and removes the line on the next two-second refresh. The line also has a
per-page dismiss button. The first install is paused until explicit in-product consent.

## Data and permissions

The provider is used locally to find the composer. Prompt text, replies, account identities,
conversation and project URLs, provider names, cookies and page network traffic are not sent
to Obrigado. The content script observes trusted input events without reading their values.
The server receives a random installation credential, extension version and exposure evidence,
under the single renderer id `obrigado-browser`. Normal network-level abuse protection still
applies, and the server stores only the installation-key digest.

The extension requires storage, a retry alarm, access to Obrigado's API and content-script
access to the four named sites. It requests no browsing-history, cookie, request-interception,
debugger, native-messaging or all-sites permission. Browser browsing data is not used to target
advertisements. All code is bundled; remote responses contain validated creative data only.

There is no CLI bridge today. Reusing a local CLI would require a separately registered
native-messaging host and installer work; a Chrome extension cannot simply launch the binary.
Standalone installation therefore uses the existing shared maintainer-grants pool. Optional
account linking can be considered separately without making the CLI a prerequisite.

## Release limits

The platform's `bun run e2e` also loads the packaged extension in real Chromium against its
real scratch-database API. Only the provider pages and advertiser landing page are fixtures:
there are no mocked sessions, creatives, beacons or redirects. It verifies consent, occlusion,
focus loss, an attended impression in Postgres, the actual campaign charge, shared delivery
across all four providers, navigation without duplicate billing, a clicked sponsor link and
pausing through the popup. The regular smoke test remains available without a database.

The integration runner builds with `OBRIGADO_BROWSER_E2E_ORIGIN` pointing at its HTTP loopback
server. This override rejects remote hosts and writes to `.output/e2e/`, leaving release
output and production permissions intact. Install Chromium with `bunx playwright install
--with-deps chromium` from `packages/browser-extension` before running the platform E2E suite;
CI does this automatically.

Controlled fixtures verify the extension mechanisms and adapter selectors. They cannot prove
that authenticated provider layouts still match; verify those manually before store submission,
including Replit's agent pane. `browser-extension-v<version>` tags build a GitHub ZIP release;
after the first manual store submission and one-time configuration, the same workflow submits
updates through WXT and Chrome API v2. See [Publishing](./PUBLISHING.md#chrome-extension).
The server change must be deployed before a public extension release.

Chrome permits ads alongside third-party pages when disclosed, clearly attributed and
noninterfering. The label and Obrigado attribution remain visible on this surface. Review is
still required; this design is not a promise of store acceptance or provider permission.
The store listing and a public extension privacy policy must match the popup's data disclosure.

Sources checked 2026-10-18:

- [Chrome ads policy](https://developer.chrome.com/docs/webstore/program-policies/ads)
- [Chrome Limited Use policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [Extension cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [WXT content-script UI](https://wxt.dev/guide/essentials/content-scripts.html)
