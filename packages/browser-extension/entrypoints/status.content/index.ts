// oxlint-disable-next-line import/no-unassigned-import -- WXT injects this stylesheet inside the shadow root
import "./style.css";
import { defineContentScript } from "wxt/utils/define-content-script";

import { MATCHES } from "../../src/providers.ts";
import { StatusController } from "../../src/controller.ts";

export default defineContentScript({
  matches: MATCHES,
  cssInjectionMode: "ui",
  main(ctx) {
    const controller = new StatusController(ctx);
    ctx.addEventListener(document, "input", controller.input, { capture: true });
    ctx.addEventListener(document, "pointerdown", controller.input, { capture: true });
    ctx.addEventListener(window, "wxt:locationchange", controller.navigate);
    ctx.setInterval(() => {
      void controller.update();
    }, 2_000);
    ctx.onInvalidated(controller.remove);
  },
});
