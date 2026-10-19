/** Real Chromium + the production extension, with all delivery mocked in its worker. */
import assert from "node:assert/strict";
import { resolve } from "node:path";

import type { BrowserContext, Page, Worker } from "playwright";
import manifest from "../package.json";
import {
  PROVIDER_FIXTURES as fixtures,
  openFixture,
  typePrompt,
  withExtension,
} from "./fixtures.ts";

interface Call {
  url: string;
  body: unknown;
}
interface TestScope {
  testCalls?: Call[];
  fetch: (input: string | Request | URL, init?: RequestInit) => Promise<Response>;
}

async function mockDelivery(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    const scope = globalThis as TestScope;
    const original = scope.fetch.bind(globalThis);
    scope.fetch = (input, init) => {
      const url = String(input);
      if (!url.startsWith("https://obrigado.dev/api/")) return original(input, init);
      (scope.testCalls ??= []).push({ url, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(
        Response.json(
          url.endsWith("/session")
            ? {
                fp: "a".repeat(32),
                serving: true,
                ttl_seconds: 300,
                batch: [
                  {
                    impression_id: crypto.randomUUID(),
                    nonce: "AAAAAAAAAAAAAAAAAAAAAA==",
                    body: "Open source maintenance, funded by useful tools.",
                    click_url: "https://obrigado.dev/c/test",
                    spans: [],
                    brand: null,
                    rev_micros: 3000,
                  },
                ],
              }
            : { accepted: 1, rejected: 0 },
        ),
      );
    };
  });
}

function calls(worker: Worker): Promise<Call[]> {
  return worker.evaluate(() => (globalThis as TestScope).testCalls ?? []);
}

async function exposureChecks(page: Page, popup: Page, worker: Worker): Promise<void> {
  await popup.bringToFront();
  await page.waitForTimeout(1_400);
  assert.equal((await calls(worker)).filter((call) => call.url.endsWith("/beacon")).length, 0);
  await page.bringToFront();
  await page.evaluate(() => {
    const cover = document.createElement("div");
    cover.id = "fixture-cover";
    cover.style.cssText = "position:fixed;inset:0;background:white;z-index:99999";
    document.body.append(cover);
  });
  await page.waitForTimeout(1_400);
  assert.equal((await calls(worker)).filter((call) => call.url.endsWith("/beacon")).length, 0);
  await page.evaluate(() => document.querySelector("#fixture-cover")?.remove());
  await page.waitForTimeout(1_400);
  assert.equal((await calls(worker)).filter((call) => call.url.endsWith("/beacon")).length, 1);
}

async function checkProvider(
  context: BrowserContext,
  popup: Page,
  worker: Worker,
  index: number,
): Promise<void> {
  const fixture = fixtures[index];
  assert.ok(fixture !== undefined);
  const [url, composer] = fixture;
  const page = await openFixture(context, url, composer);
  await page.getByRole("textbox", { name: "Message" }).dispatchEvent("input");
  assert.equal(await page.locator("obrigado-status").count(), 0);
  await typePrompt(page);
  const textColor = await page
    .locator("obrigado-status .obrigado-line")
    .evaluate((element) => getComputedStyle(element).color);
  const hostColor = await page
    .locator("main")
    .evaluate((element) => getComputedStyle(element).color);
  assert.equal(textColor, hostColor);
  if (index === 0) {
    await exposureChecks(page, popup, worker);
    await page.screenshot({ path: ".output/smoke-line.png" });
    await page.evaluate(() => history.pushState({}, "", "/c/fixture-next"));
    await page.locator("obrigado-status").waitFor({ state: "detached" });
    await typePrompt(page);
    await page.getByRole("button", { name: "Hide Obrigado for this page" }).click();
    await page.locator("obrigado-status").waitFor({ state: "detached" });
  }
  const recorded = await calls(worker);
  assert.equal(recorded.filter((call) => call.url.endsWith("/beacon")).length, 1);
  assert.ok(!JSON.stringify(recorded).includes("Private prompt"));
  assert.ok(!JSON.stringify(recorded).includes(new URL(url).hostname));
  await page.close();
}

async function smoke(context: BrowserContext): Promise<void> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await mockDelivery(worker);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await popup.getByRole("button", { name: "Agree and enable Obrigado" }).click();
  await popup.getByRole("button", { name: "Pause Obrigado" }).waitFor();
  for (let index = 0; index < fixtures.length; index += 1)
    // oxlint-disable-next-line no-await-in-loop -- each fixture must own the foreground tab
    await checkProvider(context, popup, worker, index);
  await popup.bringToFront();
  await popup.screenshot({ path: ".output/smoke-popup.png", fullPage: true });
  await popup.getByRole("button", { name: "Pause Obrigado" }).click();
  await popup.getByRole("button", { name: "Agree and enable Obrigado" }).waitFor();
  const recorded = await calls(worker);
  assert.deepEqual(recorded.find((call) => call.url.endsWith("/session"))?.body, {
    version: manifest.version,
  });
  console.log(
    `Browser smoke: ${fixtures.length} provider fixtures; focus, occlusion, navigation, consent and nonce deduplication passed.`,
  );
}

await withExtension(resolve(".output/chrome-mv3"), smoke);
