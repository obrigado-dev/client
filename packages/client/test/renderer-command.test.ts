/**
 * The command a host is given for the renderer: `obrigado` by name, or by its full path where a
 * package manager installed it, whose bin directory a Node version manager swaps out (A44).
 */
import { describe, expect, test } from "bun:test";

import { rendererCommand } from "../src/renderer-command.ts";
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
