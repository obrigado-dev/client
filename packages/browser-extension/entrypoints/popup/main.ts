// oxlint-disable-next-line import/no-unassigned-import -- the popup owns its stylesheet
import "./style.css";
import { browser } from "wxt/browser";

const button = document.querySelector<HTMLButtonElement>("#toggle");
const status = document.querySelector<HTMLElement>("#state");
let enabled = false;

function show(): void {
  if (button === null || status === null) return;
  button.disabled = false;
  button.textContent = enabled ? "Pause Obrigado" : "Agree and enable Obrigado";
  status.textContent = enabled
    ? "Enabled. Interact with a chat composer to show the line."
    : "Paused. No ads are requested or counted.";
}

enabled = (await browser.runtime.sendMessage({ type: "status" })) === true;
show();

button?.addEventListener("click", () => {
  button.disabled = true;
  void browser.runtime
    .sendMessage({ type: "configure", enabled: !enabled })
    .then((saved: unknown) => {
      if (saved === true) enabled = !enabled;
      show();
      if (saved !== true && status !== null)
        status.textContent = "Could not save. Please reopen the popup and try again.";
      return null;
    });
});
