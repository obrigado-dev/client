import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { BrowserClient } from "@obrigado/client/browser";

import { providerForUrl } from "../src/providers.ts";

const STORAGE_KEY = "obrigado-client";

export default defineBackground(() => {
  const client = new BrowserClient(
    {
      read: async () => (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY],
      write: (value) => browser.storage.local.set({ [STORAGE_KEY]: value }),
    },
    browser.runtime.getManifest().version,
    (url, init) => globalThis.fetch(url, init),
    Date.now,
    import.meta.env.VITE_OBRIGADO_API_ORIGIN,
  );

  // One worker owns rotation and billing across all tabs, including asynchronous storage writes.
  let pending = Promise.resolve<unknown>(null);
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const next = pending.then(action, action);
    pending = next.catch(() => null);
    return next;
  };

  // A content script can ask for a line but cannot read the installation credential or nonces.
  void browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  void browser.alarms.create("obrigado-flush", { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener(() => {
    void serial(() => client.flush());
  });

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (typeof message !== "object" || message === null) return false;
    const data = message as Record<string, unknown>;
    const popup =
      sender.id === browser.runtime.id && sender.url === browser.runtime.getURL("/popup.html");
    const site =
      sender.frameId === 0 && sender.url !== undefined && providerForUrl(sender.url) !== null;
    let action: (() => Promise<unknown>) | undefined;
    if (popup && data["type"] === "status") action = () => client.enabled();
    if (popup && data["type"] === "configure" && typeof data["enabled"] === "boolean") {
      const enabled = data["enabled"];
      action = async () => {
        await client.configure(enabled);
        return true;
      };
    }
    if (site && data["type"] === "render") action = () => client.render();
    if (
      site &&
      data["type"] === "confirm" &&
      typeof data["id"] === "string" &&
      typeof data["dwellMs"] === "number" &&
      typeof data["inputAgeS"] === "number"
    ) {
      const { id, dwellMs, inputAgeS } = data as { id: string; dwellMs: number; inputAgeS: number };
      action = async () => {
        const confirmed = await client.confirm(id, dwellMs, inputAgeS);
        await client.flush();
        return confirmed;
      };
    }
    if (action === undefined) return false;
    void serial(action).then(sendResponse, () => sendResponse(null));
    return true;
  });
});
