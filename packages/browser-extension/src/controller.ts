import { browser } from "wxt/browser";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { ATTENTION_WINDOW_S } from "@obrigado/client/browser-exposure";
import { parseSponsored } from "@obrigado/surface";
import type { Sponsored } from "@obrigado/surface";

import { findComposer } from "./providers.ts";
import { drawLine } from "./line.ts";
import { watchExposure } from "./exposure.ts";

export class StatusController {
  private lastInput = -Infinity;
  private dismissed = false;
  private busy = false;
  private currentId: string | null = null;
  private mountedComposer: HTMLElement | null = null;
  private cleanup: (() => void) | undefined;
  private ui: Awaited<ReturnType<typeof createShadowRootUi>> | undefined;

  constructor(private readonly ctx: ContentScriptContext) {}

  private age = (): number => (performance.now() - this.lastInput) / 1000;

  remove = (): void => {
    this.cleanup?.();
    this.cleanup = undefined;
    this.ui?.remove();
    this.ui = undefined;
    this.currentId = null;
    this.mountedComposer = null;
  };

  navigate = (): void => {
    this.lastInput = -Infinity;
    this.dismissed = false;
    this.remove();
  };

  input = (event: Event): void => {
    const composer = findComposer(document, location.href);
    if (
      !event.isTrusted ||
      composer === null ||
      !(event.target instanceof Node) ||
      !composer.contains(event.target)
    )
      return;
    this.lastInput = performance.now();
    if (this.ui === undefined) void this.update();
  };

  async update(): Promise<void> {
    if (this.busy || this.dismissed) return;
    const composer = findComposer(document, location.href);
    if (composer === null || this.age() > ATTENTION_WINDOW_S) return this.remove();
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    this.busy = true;
    try {
      const result = await browser.runtime.sendMessage({ type: "render" });
      if (this.ctx.isInvalid || this.dismissed || !composer.isConnected) return this.remove();
      if (result === null || typeof result !== "object") return this.remove();
      const line = parseSponsored(JSON.stringify(result.line));
      if (line === null || typeof result.id !== "string" || Date.now() >= result.expiresAt)
        return this.remove();
      if (
        result.id === this.currentId &&
        this.mountedComposer === composer &&
        this.ui?.shadowHost.isConnected
      )
        return;
      await this.mount(composer, result.id, line);
    } catch {
      this.remove();
    } finally {
      this.busy = false;
    }
  }

  private async mount(composer: HTMLElement, id: string, line: Sponsored): Promise<void> {
    this.remove();
    this.currentId = id;
    this.mountedComposer = composer;
    this.ui = await createShadowRootUi(this.ctx, {
      name: "obrigado-status",
      position: "inline",
      inheritStyles: true,
      anchor: composer.closest("form") ?? composer.parentElement ?? composer,
      append: "after",
      onMount: (container) => {
        container.className = "obrigado-line";
        drawLine(container, line, () => {
          this.dismissed = true;
          this.remove();
        });
        this.cleanup = watchExposure(container, this.age, (dwellMs, inputAgeS) => {
          void browser.runtime.sendMessage({ type: "confirm", id, dwellMs, inputAgeS });
        });
      },
    });
    if (this.ctx.isInvalid || this.dismissed || !composer.isConnected) return this.remove();
    this.ui.mount();
  }
}
