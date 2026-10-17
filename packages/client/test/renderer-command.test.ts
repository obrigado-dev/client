/**
 * The command a host is given for the renderer: `obrigado` by name, or by its full path where a
 * package manager installed it, whose bin directory a Node version manager swaps out (A44).
 */
import { describe, expect, test } from "bun:test";

import { forShell, rendererCommand, spawnedRendererCommand } from "../src/renderer-command.ts";
import { statusLineOwner } from "../src/statusline.ts";

const NODE = "/home/dev/.nvm/versions/node/v22.11.0";
const FROM_NPM = {
  onPath: `${NODE}/bin/obrigado`,
  binary: `${NODE}/lib/node_modules/@obrigado/client/node_modules/@obrigado/client-linux-x64/bin/obrigado`,
};

describe("the renderer command", () => {
  test("names an install.sh binary bare, which survives the binary moving", () => {
    const binary = "/home/dev/.local/bin/obrigado";

    expect(rendererCommand("claude-code", { onPath: binary, binary })).toBe(
      "obrigado statusline --agent claude-code",
    );
  });

  test("names a package manager's by the path it has, which runs under any Node version", () => {
    expect(rendererCommand("codex", FROM_NPM)).toBe(
      `${NODE}/bin/obrigado statusline --agent codex`,
    );
  });

  test("writes that path in a form uninstall still takes for ours alone", () => {
    const command = rendererCommand("claude-code", FROM_NPM);

    expect(statusLineOwner({ type: "command", command })).toBe("ours");
  });

  test("names it bare where the path would need quoting", () => {
    const home = "/Users/Jo Doe/.nvm/versions/node/v22.11.0";

    expect(
      rendererCommand(undefined, {
        onPath: `${home}/bin/obrigado`,
        binary: `${home}/lib/node_modules/@obrigado/client/node_modules/@obrigado/client-darwin-arm64/bin/obrigado`,
      }),
    ).toBe("obrigado statusline");
  });
});

/**
 * Windows (A46). Claude Code runs the command through Git Bash or PowerShell, and Bash drops a
 * backslash, so a path is written with forward slashes and with `~` for the home directory.
 */
describe("the renderer command on Windows", () => {
  const WINDOWS = { platform: "win32" as const, home: "C:\\Users\\Jo Doe" };
  const INSTALLED = "C:\\Users\\Jo Doe\\.local\\bin\\obrigado.exe";

  test("names a binary on PATH bare, as everywhere", () => {
    expect(rendererCommand("claude-code", { onPath: INSTALLED, binary: INSTALLED }, WINDOWS)).toBe(
      "obrigado statusline --agent claude-code",
    );
  });

  test("names one off PATH from home, which needs no quoting with a space in the profile", () => {
    const command = rendererCommand(
      "claude-code",
      { onPath: null, binary: INSTALLED, compiled: true },
      WINDOWS,
    );

    expect(command).toBe("~/.local/bin/obrigado.exe statusline --agent claude-code");
    expect(statusLineOwner({ type: "command", command })).toBe("ours");
  });

  test("names one elsewhere by its full path, in forward slashes", () => {
    expect(
      rendererCommand(
        undefined,
        { onPath: null, binary: "D:\\tools\\obrigado.exe", compiled: true },
        WINDOWS,
      ),
    ).toBe("D:/tools/obrigado.exe statusline");
  });

  test("names it bare where even that would need quoting", () => {
    expect(
      rendererCommand(
        undefined,
        { onPath: null, binary: "C:\\Program Files\\obrigado\\obrigado.exe", compiled: true },
        WINDOWS,
      ),
    ).toBe("obrigado statusline");
  });

  test("reads home without regard to case, as Windows does", () => {
    expect(forShell("c:\\users\\jo doe\\.local\\bin\\obrigado.exe", WINDOWS)).toBe(
      "~/.local/bin/obrigado.exe",
    );
  });

  test("leaves a path alone everywhere else", () => {
    expect(
      forShell("/Users/Jo Doe/.local/bin/obrigado", { platform: "darwin", home: "/Users/Jo Doe" }),
    ).toBe("/Users/Jo Doe/.local/bin/obrigado");
  });
});

/** The Pi extension splits its command itself and spawns it with no shell to expand `~`. */
describe("the renderer command for a host with no shell", () => {
  test("is the shell's command wherever obrigado is on PATH", () => {
    const binary = "/home/dev/.local/bin/obrigado";

    expect(spawnedRendererCommand({ onPath: binary, binary })).toBe("obrigado statusline");
  });

  test("is the full path elsewhere, in the quotes `splitCommand` keeps it whole in", () => {
    const binary = "C:\\Users\\Jo Doe\\.local\\bin\\obrigado.exe";

    expect(spawnedRendererCommand({ onPath: null, binary, compiled: true })).toBe(
      "'C:\\Users\\Jo Doe\\.local\\bin\\obrigado.exe' statusline",
    );
  });

  test("is a plain path as it was", () => {
    expect(
      spawnedRendererCommand({
        onPath: null,
        binary: "/home/dev/bin/obrigado",
        compiled: true,
      }),
    ).toBe("/home/dev/bin/obrigado statusline");
  });
});
