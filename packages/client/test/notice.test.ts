/**
 * Pacing for Obrigado's own notices (A30): one window a day per install, and the window holds.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  NOTICE_EVERY_MS,
  NOTICE_LABEL,
  NOTICE_WINDOW_MS,
  noticeForRender,
  noticeLine,
  noticeParts,
} from "../src/notice.ts";

const NOTICE = { id: "update-0.2", body: "Obrigado 0.2 is out.", url: "https://obrigado.dev/u" };
const T0 = 1_800_000_000_000;

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "obrigado-notice-"));
  path = join(dir, "notice.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("when a notice takes the slot", () => {
  test("no notice, no window", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- the absent notice IS the case under test
    expect(await noticeForRender(undefined, T0, path)).toBeNull();
  });

  test("the first sighting opens a window, and every render inside it agrees", async () => {
    expect(await noticeForRender(NOTICE, T0, path)).toEqual(NOTICE);
    expect(await noticeForRender(NOTICE, T0 + NOTICE_WINDOW_MS - 1, path)).toEqual(NOTICE);
  });

  test("the window closes, and the slot goes back to the rotation for the rest of the day", async () => {
    await noticeForRender(NOTICE, T0, path);
    expect(await noticeForRender(NOTICE, T0 + NOTICE_WINDOW_MS, path)).toBeNull();
    expect(await noticeForRender(NOTICE, T0 + NOTICE_EVERY_MS - 1, path)).toBeNull();
  });

  test("a day later it may show again", async () => {
    await noticeForRender(NOTICE, T0, path);
    expect(await noticeForRender(NOTICE, T0 + NOTICE_EVERY_MS, path)).toEqual(NOTICE);
  });

  test("pacing is per install, not per notice: a second notice waits its turn", async () => {
    await noticeForRender(NOTICE, T0, path);
    const other = { ...NOTICE, id: "reinstall-pi" };
    expect(await noticeForRender(other, T0 + 1000, path)).toBeNull();
  });

  test("a clock that moved backwards errs toward the ad", async () => {
    await noticeForRender(NOTICE, T0, path);
    expect(await noticeForRender({ ...NOTICE, id: "other" }, T0 - 5000, path)).toBeNull();
  });

  test("a ledger that cannot be written shows nothing, rather than showing on every render", async () => {
    // A path whose parent is a file: the directory can never be created.
    await writeFile(join(dir, "blocker"), "");
    expect(await noticeForRender(NOTICE, T0, join(dir, "blocker", "notice.json"))).toBeNull();
  });

  test("a corrupt ledger is treated as never shown", async () => {
    await writeFile(path, "{not json");
    expect(await noticeForRender(NOTICE, T0, path)).toEqual(NOTICE);
  });
});

describe("how a notice is drawn", () => {
  test("labelled as ours, never as sponsored", () => {
    const line = noticeLine(NOTICE, { TERM: "dumb" });
    expect(line).toBe(`${NOTICE_LABEL} · ${NOTICE.body}`);
    expect(line).not.toContain("oss-sponsor");
  });

  test("the label stays outside the link", () => {
    const line = noticeLine(NOTICE, { TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" });
    expect(line.startsWith(`${NOTICE_LABEL} · `)).toBe(true);
    expect(line).toContain(NOTICE.url);
  });

  test("the parts are what an existing host already parses, plus a kind it may ignore", () => {
    const parts = noticeParts({ ...NOTICE, body: `${String.fromCodePoint(0x1b)}[31mred` });
    expect(parts).toMatchObject({ kind: "notice", label: NOTICE_LABEL, url: NOTICE.url });
    // Sanitised on the way out even though the server refuses control characters: two layers.
    expect(JSON.stringify(parts)).not.toContain(String.fromCodePoint(0x1b));
  });
});
