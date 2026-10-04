/**
 * The VS Code extension's install into VS Code and Cursor (A40), with the network faked at
 * `fetch` and the editor's tool faked at `run`.
 *
 * The claims: what is installed is the latest release's `.vsix`, fetched through obrigado.dev so
 * it is counted, and held to the release's signed checksums whoever served it; nothing is
 * downloaded when the installed version is current; and the editor's own tool does the install.
 */
import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";

import {
  EXTENSION_ID,
  installEditorExtension,
  installedVersion,
  uninstallEditorExtension,
} from "../src/editor-extension.ts";
import type { EditorDeps, Ran } from "../src/editor-extension.ts";
import { signSums } from "../src/release-signature.ts";

const VSIX = new TextEncoder().encode("PK the extension");
const SUMS = `${createHash("sha256").update(VSIX).digest("hex")}  obrigado-vscode-0.4.0.vsix\n`;

const pair = generateKeyPairSync("ed25519");
const KEY = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const PEM = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

function reply(body: string | Uint8Array, url: string, ok = true): Response {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    ok,
    url,
    json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(bytes)) as unknown),
    arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
  } as Response;
}

interface Fakes {
  readonly fetched: string[];
  readonly ran: (readonly string[])[];
  readonly installedFiles: string[];
}

/** GitHub and obrigado.dev as the install sees them, and an editor with `listed` installed. */
function world(options: { listed?: string; asset?: Uint8Array; countingDown?: boolean } = {}): {
  deps: EditorDeps;
  fakes: Fakes;
} {
  const fakes: Fakes = { fetched: [], ran: [], installedFiles: [] };
  const fetch: EditorDeps["fetch"] = (input) => {
    fakes.fetched.push(input);
    if (input.endsWith("/releases/latest")) {
      return Promise.resolve(reply(JSON.stringify({ tag_name: "v0.4.0" }), input));
    }
    const github = `https://objects.githubusercontent.com/${input.split("/").at(-1)}`;
    if (input.endsWith("/SHA256SUMS.sig")) {
      return Promise.resolve(reply(signSums(new TextEncoder().encode(SUMS), PEM), github));
    }
    if (input.endsWith("/SHA256SUMS")) return Promise.resolve(reply(SUMS, github));
    if (input.startsWith("https://obrigado.test/") && options.countingDown === true) {
      return Promise.resolve(reply("Bad Gateway", input, false));
    }
    return Promise.resolve(reply(options.asset ?? VSIX, github));
  };
  const run = (argv: readonly string[]): Promise<Ran> => {
    fakes.ran.push(argv);
    if (argv.includes("--list-extensions")) {
      return Promise.resolve({ code: 0, stdout: options.listed ?? "ms-python.python@2026.1.0\n" });
    }
    if (argv.includes("--install-extension")) {
      const file = argv[argv.indexOf("--install-extension") + 1] ?? "";
      if (existsSync(file)) fakes.installedFiles.push(file);
    }
    return Promise.resolve({ code: 0, stdout: "" });
  };
  return {
    deps: {
      fetch,
      run,
      current: "0.3.3",
      keys: [KEY],
      origin: "https://obrigado.test",
      cli: "code",
    },
    fakes,
  };
}

describe("installing the extension into an editor", () => {
  test("installs the latest release's .vsix, fetched through obrigado.dev, with the editor's tool", async () => {
    const { deps, fakes } = world();

    expect(await installEditorExtension("vscode", deps)).toEqual({
      status: "installed",
      version: "0.4.0",
    });
    expect(fakes.fetched).toContain("https://obrigado.test/vscode/download/0.4.0?via=cli");
    const install = fakes.ran.find((argv) => argv.includes("--install-extension")) ?? [];
    expect(install[0]).toBe("code");
    expect(install.at(-1)).toBe("--force");
    // The file existed when the editor was handed it, kept the asset's name, and is gone now.
    expect(fakes.installedFiles).toHaveLength(1);
    expect(fakes.installedFiles[0]).toEndWith("obrigado-vscode-0.4.0.vsix");
    expect(existsSync(fakes.installedFiles[0] ?? "")).toBe(false);
  });

  test("downloads nothing when the installed version is the latest", async () => {
    const { deps, fakes } = world({ listed: `${EXTENSION_ID}@0.4.0\n` });

    expect((await installEditorExtension("cursor", deps)).status).toBe("already-installed");
    expect(fakes.fetched.some((url) => url.includes(".vsix") || url.includes("/download/"))).toBe(
      false,
    );
  });

  test("refuses bytes the signed checksums do not describe, whoever served them", async () => {
    const { deps, fakes } = world({ asset: new TextEncoder().encode("something else") });

    const outcome = await installEditorExtension("vscode", deps);
    expect(outcome).toEqual({
      status: "failed",
      reason: "checksum mismatch for obrigado-vscode-0.4.0.vsix: not installed",
    });
    expect(fakes.ran.some((argv) => argv.includes("--install-extension"))).toBe(false);
  });

  test("falls back to GitHub when obrigado.dev cannot answer", async () => {
    const { deps, fakes } = world({ countingDown: true });

    expect((await installEditorExtension("vscode", deps)).status).toBe("installed");
    expect(fakes.fetched).toContain(
      "https://github.com/obrigado-dev/client/releases/download/v0.4.0/obrigado-vscode-0.4.0.vsix",
    );
  });

  test("says so when the editor's tool is not on this machine", async () => {
    const { deps } = world();

    expect(await installEditorExtension("cursor", { ...deps, cli: null })).toEqual({
      status: "failed",
      reason: "`cursor` was not found",
    });
  });
});

describe("removing it", () => {
  test("only where it is installed", async () => {
    const present = world({ listed: `${EXTENSION_ID}@0.4.0\n` });
    expect(await uninstallEditorExtension("vscode", present.deps)).toBe("removed");
    expect(present.fakes.ran.at(-1)).toEqual(["code", "--uninstall-extension", EXTENSION_ID]);

    const absent = world();
    expect(await uninstallEditorExtension("vscode", absent.deps)).toBe("not-installed");
    expect(absent.fakes.ran.some((argv) => argv.includes("--uninstall-extension"))).toBe(false);
  });
});

/** An editor that lists ours with its own capitalisation. */
function listsMixedCase(): Promise<Ran> {
  return Promise.resolve({
    code: 0,
    stdout: "Obrigado.Obrigado-VSCode@0.3.9\nother.thing@1.0.0\n",
  });
}

describe("reading what an editor has installed", () => {
  test("matches the id however the editor cases it", async () => {
    expect(await installedVersion("code", listsMixedCase)).toBe("0.3.9");
  });
});
