import { describe, expect, test } from "bun:test";

import {
  parseToml,
  removeTomlKey,
  removeTomlTable,
  sameExcept,
  setTomlKey,
  setTomlTable,
  TomlEditError,
  tomlString,
  withoutPath,
  withPath,
} from "../src/toml-edit.ts";

/** A config a developer keeps by hand: comments, their own order, a table we will edit. */
const HAND_WRITTEN = `# my codex settings
model = "gpt-6.1"

[tui]
# what the footer shows
status_line = ["model-with-reasoning", "current-dir"]
theme = "catppuccin"

# servers
[mcp_servers.docs]
command = "docs-mcp"
args = ["--stdio"]

[mcp_servers.docs.env]
TOKEN = "x"
`;

describe("setting a key", () => {
  test("adds it after the table's last setting, above what leads into the next table", () => {
    const next = setTomlKey(HAND_WRITTEN, ["tui"], "status_line_provider", '"default"');
    expect(next).toContain('theme = "catppuccin"\nstatus_line_provider = "default"\n\n# servers\n');
    expect(
      sameExcept(HAND_WRITTEN, next, (tree) =>
        withPath(tree, ["tui", "status_line_provider"], "default"),
      ),
    ).toBe(true);
  });

  test("replaces the line where the key is already set, and nothing else", () => {
    const next = setTomlKey(HAND_WRITTEN, ["tui"], "theme", '"dracula"');
    expect(next).toBe(HAND_WRITTEN.replace('theme = "catppuccin"', 'theme = "dracula"'));
  });

  test("keeps the indentation of the line it replaces", () => {
    const indented = "[features]\n  shell_tool = true\n";
    expect(setTomlKey(indented, ["features"], "shell_tool", "false")).toBe(
      "[features]\n  shell_tool = false\n",
    );
  });

  test("adds the table at the end where the file has none", () => {
    const next = setTomlKey(HAND_WRITTEN, ["features"], "tui_extensions_statusline", "true");
    expect(next).toBe(`${HAND_WRITTEN}\n[features]\ntui_extensions_statusline = true\n`);
  });

  test("writes a first table into an empty file without a leading blank line", () => {
    expect(setTomlKey("", ["features"], "x", "true")).toBe("[features]\nx = true\n");
  });

  test("a table above its sub-table is found by its own header, not the sub-table's", () => {
    const text = "[tui.effects]\nshimmer = true\n\n[tui]\nanimations = false\n";
    const next = setTomlKey(text, ["tui"], "status_line_provider", '"default"');
    expect(next).toBe(
      '[tui.effects]\nshimmer = true\n\n[tui]\nanimations = false\nstatus_line_provider = "default"\n',
    );
  });

  test("a table that only has sub-tables gets its own header, which TOML allows", () => {
    const text = "[tui.effects]\nshimmer = true\n";
    const next = setTomlKey(text, ["tui"], "status_line_provider", '"default"');
    expect(parseToml(next)).toEqual({
      tui: { effects: { shimmer: true }, status_line_provider: "default" },
    });
  });

  test("refuses a table that is set as dotted keys, where a header would define it twice", () => {
    expect(() =>
      setTomlKey('tui.theme = "x"\n', ["tui"], "status_line_provider", '"default"'),
    ).toThrow(TomlEditError);
    expect(() => setTomlKey('tui = { theme = "x" }\n', ["tui"], "a", "1")).toThrow(TomlEditError);
  });

  test("a CRLF file stays CRLF", () => {
    const next = setTomlKey('[tui]\r\ntheme = "x"\r\n', ["tui"], "a", "1");
    expect(next).toBe('[tui]\r\ntheme = "x"\r\na = 1\r\n');
  });

  test("a quoted table name is matched by what it names", () => {
    const text = '[mcp_servers."my.server"]\ncommand = "x"\n';
    const next = setTomlKey(text, ["mcp_servers", "my.server"], "enabled", "false");
    expect(next).toBe('[mcp_servers."my.server"]\ncommand = "x"\nenabled = false\n');
  });
});

describe("removing a key", () => {
  test("takes the line and leaves the table its owner wrote", () => {
    const withKey = setTomlKey(HAND_WRITTEN, ["tui"], "status_line_provider", '"default"');
    expect(removeTomlKey(withKey, ["tui"], "status_line_provider")).toBe(HAND_WRITTEN);
  });

  test("takes the header too where the table was only ever that key", () => {
    const withKey = setTomlKey(HAND_WRITTEN, ["features"], "tui_extensions_statusline", "true");
    expect(removeTomlKey(withKey, ["features"], "tui_extensions_statusline")).toBe(HAND_WRITTEN);
  });

  test("keeps a header that still has a comment under it", () => {
    const text = "[features]\n# experiments\nx = true\n";
    expect(removeTomlKey(text, ["features"], "x")).toBe("[features]\n# experiments\n");
  });

  test("keeps a header that sub-tables hang from", () => {
    const text = "[tui]\na = 1\n\n[tui.effects]\nshimmer = true\n";
    const next = removeTomlKey(text, ["tui"], "a");
    expect(parseToml(next)).toEqual({ tui: { effects: { shimmer: true } } });
  });

  test("is unchanged when the key or the table is not there", () => {
    expect(removeTomlKey(HAND_WRITTEN, ["tui"], "nope")).toBe(HAND_WRITTEN);
    expect(removeTomlKey(HAND_WRITTEN, ["nope"], "x")).toBe(HAND_WRITTEN);
  });
});

describe("a whole table", () => {
  const BODY = ['command = "/usr/local/bin/obrigado"', 'args = ["codex-provider"]'];

  test("is added at the end, and removing it gives the file back", () => {
    const next = setTomlTable(HAND_WRITTEN, ["mcp_servers", "obrigado"], BODY);
    expect(next).toBe(`${HAND_WRITTEN}\n[mcp_servers.obrigado]\n${BODY.join("\n")}\n`);
    expect(removeTomlTable(next, ["mcp_servers", "obrigado"])).toBe(HAND_WRITTEN);
  });

  test("replaces the one already there, its sub-tables with it", () => {
    const old = `${HAND_WRITTEN}\n[mcp_servers.obrigado]\ncommand = "old"\n\n[mcp_servers.obrigado.env]\nA = "1"\n`;
    const next = setTomlTable(old, ["mcp_servers", "obrigado"], BODY);
    expect(parseToml(next)?.["mcp_servers"]).toEqual({
      docs: { command: "docs-mcp", args: ["--stdio"], env: { TOKEN: "x" } },
      obrigado: { command: "/usr/local/bin/obrigado", args: ["codex-provider"] },
    });
  });

  test("removing one in the middle keeps the comment that leads into the next", () => {
    const text = '[a]\nx = 1\n\n[mcp_servers.obrigado]\ncommand = "o"\n\n# the rest\n[b]\ny = 2\n';
    expect(removeTomlTable(text, ["mcp_servers", "obrigado"])).toBe(
      "[a]\nx = 1\n\n# the rest\n[b]\ny = 2\n",
    );
  });

  test("removing a neighbour's table is not removing ours", () => {
    const next = removeTomlTable(HAND_WRITTEN, ["mcp_servers", "doc"]);
    expect(next).toBe(HAND_WRITTEN);
  });

  test("removing the only table leaves an empty file", () => {
    expect(
      removeTomlTable('[mcp_servers.obrigado]\ncommand = "o"\n', ["mcp_servers", "obrigado"]),
    ).toBe("");
  });
});

describe("holding an edit to what was asked", () => {
  test("accepts exactly the change", () => {
    const next = setTomlKey(HAND_WRITTEN, ["features"], "x", "true");
    expect(sameExcept(HAND_WRITTEN, next, (tree) => withPath(tree, ["features", "x"], true))).toBe(
      true,
    );
  });

  test("rejects an edit that changed something else", () => {
    const next = setTomlKey(HAND_WRITTEN, ["tui"], "theme", '"dracula"');
    expect(sameExcept(HAND_WRITTEN, next, (tree) => tree)).toBe(false);
  });

  test("rejects text that no longer parses", () => {
    expect(sameExcept(HAND_WRITTEN, `${HAND_WRITTEN}\n[tui]\na = 1\n`, (tree) => tree)).toBe(false);
  });

  test("catches a key whose value ran over several lines, which the editor cut in half", () => {
    const text = '[tui]\nstatus_line = [\n  "model",\n]\n';
    const next = setTomlKey(text, ["tui"], "status_line", '["current-dir"]');
    expect(
      sameExcept(text, next, (tree) => withPath(tree, ["tui", "status_line"], ["current-dir"])),
    ).toBe(false);
  });

  test("catches a header-shaped line inside a multi-line string", () => {
    const text = 'notes = """\n[tui]\nnot a table\n"""\n';
    const next = setTomlKey(text, ["tui"], "a", "1");
    expect(sameExcept(text, next, (tree) => withPath(tree, ["tui", "a"], 1))).toBe(false);
  });

  test("an emptied table and no table are the same file to Codex", () => {
    expect(sameExcept("[tui]\na = 1\n", "[tui]\n", (tree) => withoutPath(tree, ["tui", "a"]))).toBe(
      true,
    );
    expect(sameExcept("[tui]\na = 1\n", "", (tree) => withoutPath(tree, ["tui", "a"]))).toBe(true);
  });
});

test("a Windows path survives being written as a TOML string", () => {
  const path = String.raw`C:\Users\Jo Doe\.local\bin\obrigado.exe`;
  const text = setTomlTable("", ["mcp_servers", "obrigado"], [`command = ${tomlString(path)}`]);
  expect(parseToml(text)).toEqual({ mcp_servers: { obrigado: { command: path } } });
});
