import type { Sponsored, SponsoredSpan } from "@obrigado/surface";

function drawSpan(span: SponsoredSpan, url: string): HTMLElement {
  const node = document.createElement(span.link === true ? "a" : "span");
  node.textContent = span.text;
  if (node instanceof HTMLAnchorElement) {
    node.href = url;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
  }
  if (span.bold === true) node.style.fontWeight = "600";
  if (span.italic === true) node.style.fontStyle = "italic";
  if (span.color !== undefined) node.dataset["color"] = span.color;
  return node;
}

/** DOM nodes only: paid copy is never interpreted as HTML. */
export function drawLine(container: HTMLElement, line: Sponsored, dismiss: () => void): void {
  const source = document.createElement("a");
  source.textContent = "Obrigado";
  source.href = "https://obrigado.dev";
  source.target = "_blank";
  source.rel = "noopener noreferrer";
  source.className = "source";
  const label = document.createElement("span");
  label.textContent = `${line.label ?? ""} · `;
  const copy = document.createElement("span");
  copy.append(...line.spans.map((span) => drawSpan(span, line.url)));
  copy.className = "copy";
  copy.dataset["color"] = line.style;
  if (line.effect === "italic") copy.style.fontStyle = "italic";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.ariaLabel = "Hide Obrigado for this page";
  close.addEventListener("click", dismiss);
  container.replaceChildren(source, label, copy, close);
}
