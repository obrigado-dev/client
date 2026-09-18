/**
 * Obrigado's own notices (A30): when one takes the sponsored slot, and how it is drawn.
 *
 * Paced per INSTALL, across every host and session, because what is being rationed is the
 * developer's attention rather than any one surface. Somebody running Claude Code and Pi side by
 * side sees a notice once a day, not once a day per host: one window, as long as a creative holds
 * the line, and then the slot goes back to the rotation.
 *
 * Nothing here reports anything. A notice carries no nonce, the beacon path is never called for
 * one, and the rotation does not advance while it shows — the slot it borrows is simply unbilled
 * for that window.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ClientNotice } from "@obrigado/shared";
import { ROTATE_AFTER_MS } from "@obrigado/shared/rotation";

import { ensureDir, NOTICE_PATH } from "./config.ts";
import { hyperlink, stripControlCharacters, supportsHyperlinks } from "./link.ts";
import type { LinkEnvironment } from "./link.ts";
import { underline } from "./style.ts";

/** One window: as long as one creative holds the line. */
export const NOTICE_WINDOW_MS = ROTATE_AFTER_MS;

/** At most one window a day. */
export const NOTICE_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * The label a notice wears, in the place `sponsored` goes.
 *
 * Never `sponsored`: nobody paid for this line, and calling it an ad would be a false disclosure
 * in the other direction. The label says whose line it is, which is the job a label does.
 */
export const NOTICE_LABEL = "obrigado";

interface NoticeLedger {
  readonly id: string;
  readonly started_at: number;
}

async function readLedger(path: string): Promise<NoticeLedger | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<NoticeLedger>;
    return typeof parsed.id === "string" && typeof parsed.started_at === "number"
      ? { id: parsed.id, started_at: parsed.started_at }
      : null;
  } catch {
    return null;
  }
}

/** Atomic, like session state: a torn write here would read back as "never shown". */
async function writeLedger(ledger: NoticeLedger, path: string): Promise<boolean> {
  try {
    await ensureDir(dirname(path));
    const temporary = `${path}.obrigado-${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The notice this render should show instead of the rotation, or null.
 *
 * A window already open for this notice keeps it, so every repaint inside the window agrees.
 * Otherwise a window opens only if the last one began at least a day ago. A clock that has moved
 * backwards reads as "recently", which errs toward the ad.
 *
 * If the ledger cannot be written the notice does not show. Pacing that cannot be recorded is no
 * pacing at all, and an unpaced notice would take the slot on every render.
 */
export async function noticeForRender(
  notice: ClientNotice | undefined,
  now = Date.now(),
  path = NOTICE_PATH,
): Promise<ClientNotice | null> {
  if (notice === undefined) return null;

  const ledger = await readLedger(path);
  if (ledger !== null) {
    const age = now - ledger.started_at;
    if (ledger.id === notice.id && age >= 0 && age < NOTICE_WINDOW_MS) return notice;
    if (age < NOTICE_EVERY_MS) return null;
  }

  return (await writeLedger({ id: notice.id, started_at: now }, path)) ? notice : null;
}

/** The body as it may reach a terminal or a host: sanitised, whatever the server checked. */
function safeBody(notice: ClientNotice): string {
  return stripControlCharacters(notice.body).trim();
}

/**
 * A notice as a terminal line: the label, unstyled and outside the link, then the body.
 *
 * The same order a sponsored line uses, for the same reason: the label is what cannot be clicked
 * or restyled.
 */
export function noticeLine(notice: ClientNotice, env: LinkEnvironment = process.env): string {
  const body = safeBody(notice);
  const copy = supportsHyperlinks(env) ? hyperlink(underline(body), notice.url, env) : body;
  return `${NOTICE_LABEL} · ${copy}`;
}

/**
 * A notice as `--json` parts, in the shape every host already parses.
 *
 * `@obrigado/surface`'s `parseSponsored` accepts any non-empty label, so a host released before
 * notices existed draws this correctly — label first, one link over the copy — without knowing
 * what it is. `kind` is there for a host that wants to tell the two apart, and costs an older
 * one nothing.
 */
export function noticeParts(notice: ClientNotice): Record<string, unknown> {
  const copy = safeBody(notice);
  return {
    kind: "notice",
    label: NOTICE_LABEL,
    copy,
    url: notice.url,
    spans: [{ text: copy, link: true }],
    style: "default",
    effect: "none",
    brand: null,
  };
}
