/** Browser-only fixtures shared by mocked smoke tests and the real-backend integration run. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { BrowserContext, Page, Worker } from "playwright";
export type { BrowserContext, Page, Worker } from "playwright";

export const PROVIDER_FIXTURES = [
  [
    "https://chatgpt.com/c/fixture",
    '<form><div contenteditable="true" id="prompt-textarea" role="textbox" aria-label="Message"></div></form>',
  ],
  [
    "https://claude.ai/chat/fixture",
    '<form><div contenteditable="true" class="ProseMirror" role="textbox" aria-label="Message"></div></form>',
  ],
  [
    "https://chat.deepseek.com/a/chat/fixture",
    '<form><textarea placeholder="Message DeepSeek" aria-label="Message"></textarea></form>',
  ],
  [
    "https://replit.com/@example/fixture",
    '<section><textarea data-cy="agent-chat-textarea" aria-label="Message"></textarea></section>',
  ],
] as const;

export async function openFixture(
  context: BrowserContext,
  url: string,
  composer: string,
): Promise<Page> {
  await context.route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
    <html><head><style>body{font-family:system-ui;margin:40px;background:#f6f3eb;color:#242424}
    ${url.includes("claude.ai") ? "body{color-scheme:dark;background:#14181a;color:#f2f6f3}" : ""}
    main{max-width:700px;margin:auto}form,section{margin-top:40px}
    textarea,[contenteditable]{display:block;box-sizing:border-box;width:100%;min-height:80px;
    padding:12px;border:1px solid #bbb;border-radius:12px;background:Canvas;color:CanvasText}</style></head>
    <body><main><h1>AI chat fixture</h1><p>Provider conversation remains outside Obrigado.</p>${composer}</main></body></html>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(url);
  // Playwright normally forces every page to appear focused and visible, even in background.
  const protocol = await context.newCDPSession(page);
  await protocol.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await page.bringToFront();
  // document_idle is deliberately after load; allow the extension listener to register.
  await page.waitForTimeout(400);
  return page;
}

export async function typePrompt(page: Page): Promise<void> {
  await page.getByRole("textbox", { name: "Message" }).click();
  await page.keyboard.insertText("Private prompt that must stay local");
  await page.locator("obrigado-status").waitFor({ state: "visible" });
  await page.getByText("oss-sponsor ·", { exact: false }).waitFor();
}

export async function withExtension(
  extension: string,
  action: (context: BrowserContext) => Promise<void>,
): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "obrigado-browser-"));
  try {
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    try {
      await action(context);
    } finally {
      await context.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

/** Observe the nonce selected by the real client, without changing its state or transport. */
export function currentDelivery(worker: Worker) {
  return worker.evaluate(async () => {
    const extension = globalThis as unknown as {
      chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
    };
    const raw = (await extension.chrome.storage.local.get("obrigado-client"))[
      "obrigado-client"
    ] as {
      key: string;
      batch: {
        cursor: number;
        batch: Array<{ impression_id: string; click_url: string; rev_micros: number }>;
      };
    };
    const item = raw.batch.batch[raw.batch.cursor];
    if (item === undefined) throw new Error("The extension has no current delivery");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw.key));
    const keyHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return { id: item.impression_id, url: item.click_url, micros: item.rev_micros, keyHash };
  });
}
