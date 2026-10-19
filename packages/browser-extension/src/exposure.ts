import { ATTENTION_WINDOW_S, WEBSITE_VIEWABLE_MS } from "@obrigado/client/browser-exposure";

/** One continuous exposure. Losing focus, visibility or intersection resets the clock. */
export function watchExposure(
  element: HTMLElement,
  inputAge: () => number,
  confirm: (dwellMs: number, inputAgeS: number) => void,
): () => void {
  let visible = false;
  let started: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const eligible = (): boolean =>
    element.isConnected &&
    visible &&
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    inputAge() <= ATTENTION_WINDOW_S;
  const reset = (): void => {
    clearTimeout(timer);
    timer = undefined;
    started = null;
  };
  const check = (): void => {
    if (!eligible()) return reset();
    if (done || started !== null) return;
    started = performance.now();
    timer = setTimeout(() => {
      if (!eligible() || started === null) return reset();
      // Check the browser's visibility history too, in case an event was delayed while asleep.
      const hidden = performance
        .getEntriesByType("visibility-state")
        .some((entry) => entry.name === "hidden" && entry.startTime >= (started ?? Infinity));
      if (hidden) {
        reset();
        check();
        return;
      }
      done = true;
      confirm(performance.now() - started, inputAge());
    }, WEBSITE_VIEWABLE_MS);
  };
  const observer = new IntersectionObserver(
    ([entry]) => {
      visible =
        entry?.isIntersecting === true &&
        entry.intersectionRatio >= 0.5 &&
        (entry as IntersectionObserverEntry & { isVisible?: boolean }).isVisible === true;
      check();
    },
    { threshold: [0, 0.5], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
  );
  observer.observe(element);
  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
  window.addEventListener("blur", check);
  return () => {
    reset();
    observer.disconnect();
    document.removeEventListener("visibilitychange", check);
    window.removeEventListener("focus", check);
    window.removeEventListener("blur", check);
  };
}
