import { describe, expect, test } from "bun:test";

import { parseSponsored, splitCommand, statuslineArgv } from "../src/index.ts";

describe("parseSponsored", () => {
  const line = JSON.stringify({
    label: "sponsored",
    copy: "Postgres, but you never think about it — neon.tech",
    url: "https://obrigado.dev/c/tok",
    spans: [{ text: "Postgres", bold: true, link: true }],
    style: "cyan",
    effect: "italic",
    brand: { name: "Neon", logo: "data:image/png;base64,AAAA" },
  });

  test("keeps every part the renderer sent", () => {
    expect(parseSponsored(line)).toEqual({
      label: "sponsored",
      copy: "Postgres, but you never think about it — neon.tech",
      url: "https://obrigado.dev/c/tok",
      spans: [{ text: "Postgres", bold: true, link: true }],
      style: "cyan",
      effect: "italic",
      brand: { name: "Neon", logo: "data:image/png;base64,AAAA" },
    });
  });

  test("label, copy and URL, or nothing", () => {
    // A creative without its label is an undisclosed advertisement; one without its URL is
    // an impression nobody can act on. Neither is drawn.
    for (const missing of ["label", "copy", "url"]) {
      const partial = JSON.parse(line) as Record<string, unknown>;
      delete partial[missing];
      expect(parseSponsored(JSON.stringify(partial))).toBeNull();
      expect(parseSponsored(JSON.stringify({ ...partial, [missing]: "" }))).toBeNull();
    }
  });

  test("an older renderer that sends no styling still renders, as one link", () => {
    const bare = JSON.stringify({ label: "sponsored", copy: "hello", url: "https://x.example" });
    expect(parseSponsored(bare)).toEqual({
      label: "sponsored",
      copy: "hello",
      url: "https://x.example",
      spans: [{ text: "hello", link: true }],
      style: "default",
      effect: "none",
      brand: null,
    });
  });

  test("a brand without a name is not a brand", () => {
    const nameless = JSON.stringify({
      label: "sponsored",
      copy: "hello",
      url: "https://x.example",
      brand: { logo: "data:image/png;base64,AAAA" },
    });
    expect(parseSponsored(nameless)?.brand).toBeNull();
  });

  test("garbage is null, never a throw", () => {
    expect(parseSponsored("")).toBeNull();
    expect(parseSponsored("not json")).toBeNull();
    expect(parseSponsored("42")).toBeNull();
    expect(parseSponsored("null")).toBeNull();
  });
});

describe("splitCommand", () => {
  test("splits on whitespace", () => {
    expect(splitCommand("obrigado  statusline\t--agent pi")).toEqual([
      "obrigado",
      "statusline",
      "--agent",
      "pi",
    ]);
  });

  test("keeps a quoted path with a space in it whole", () => {
    // The bug every host copy had: a source checkout under a directory with a space became
    // four arguments and the spawn failed silently.
    expect(splitCommand('bun "/Users/Jane Doe/obrigado/cli.ts" statusline')).toEqual([
      "bun",
      "/Users/Jane Doe/obrigado/cli.ts",
      "statusline",
    ]);
    expect(splitCommand("bun '/Users/Jane Doe/cli.ts' statusline")).toEqual([
      "bun",
      "/Users/Jane Doe/cli.ts",
      "statusline",
    ]);
    expect(splitCommand("bun /Users/Jane\\ Doe/cli.ts statusline")).toEqual([
      "bun",
      "/Users/Jane Doe/cli.ts",
      "statusline",
    ]);
  });

  test("an empty string is an empty argv", () => {
    expect(splitCommand("")).toEqual([]);
    expect(splitCommand("   ")).toEqual([]);
  });

  test("an unterminated quote takes the rest of the line rather than throwing", () => {
    expect(splitCommand('bun "unterminated path')).toEqual(["bun", "unterminated path"]);
  });
});

describe("statuslineArgv", () => {
  test("the installed case runs obrigado from PATH and asks for json", () => {
    expect(statuslineArgv("opencode")).toEqual([
      "obrigado",
      "statusline",
      "--agent",
      "opencode",
      "--json",
    ]);
  });

  test("an override replaces the executable and keeps the host's own arguments", () => {
    expect(statuslineArgv("vscode", 'bun "/a b/cli.ts" statusline')).toEqual([
      "bun",
      "/a b/cli.ts",
      "statusline",
      "--agent",
      "vscode",
      "--json",
    ]);
  });

  test("a blank override is no override", () => {
    expect(statuslineArgv("cursor", "   ")).toEqual(statuslineArgv("cursor"));
  });

  test("a host that wants the rendered line rather than the parts can say so", () => {
    expect(statuslineArgv("pi", undefined, { json: false })).toEqual([
      "obrigado",
      "statusline",
      "--agent",
      "pi",
    ]);
  });
});

describe("the palette", () => {
  test("an unknown slot or effect degrades to none rather than to a string", () => {
    const line = JSON.stringify({
      label: "sponsored",
      copy: "hello",
      url: "https://x.example",
      style: "red",
      effect: "blink",
    });
    expect(parseSponsored(line)).toMatchObject({ style: "default", effect: "none" });
  });
});
