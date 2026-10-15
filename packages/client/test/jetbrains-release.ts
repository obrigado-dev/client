/**
 * A client release as the JetBrains install fetches it, for the tests: GitHub's latest release,
 * its signed SHA256SUMS, `editors.json` and the plugin's zip, and obrigado.dev's counting redirect
 * in front of the zip.
 */
import { createHash, generateKeyPairSync } from "node:crypto";

import { signSums } from "../src/release-signature.ts";

const pair = generateKeyPairSync("ed25519");
const KEY = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const PEM = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

export const ORIGIN = "https://obrigado.test";

export function pluginZip(version: string): Uint8Array {
  return new TextEncoder().encode(`PK the plugin ${version}`);
}

function editorsJson(version: string): string {
  return JSON.stringify({
    version,
    jetbrains: {
      id: "dev.obrigado",
      file: `obrigado-jetbrains-${version}.zip`,
      sinceBuild: "251",
      untilBuild: null,
    },
    vscode: { id: "obrigado.obrigado-vscode", file: `obrigado-vscode-${version}.vsix` },
  });
}

function reply(body: string | Uint8Array, url: string, ok = true): Response {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    ok,
    url,
    json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(bytes)) as unknown),
    arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
  } as Response;
}

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface ReleaseOptions {
  readonly version?: string;
  /** What is served as the zip, when it is not the one the checksums describe. */
  readonly zip?: Uint8Array;
  /** obrigado.dev answering 502 rather than redirecting. */
  readonly countingDown?: boolean;
}

/** The release, and every URL the code under test asked for. */
export function release(options: ReleaseOptions = {}): {
  fetch: (input: string) => Promise<Response>;
  keys: readonly string[];
  fetched: string[];
} {
  const version = options.version ?? "0.4.0";
  const editors = new TextEncoder().encode(editorsJson(version));
  const sums = [
    `${digest(pluginZip(version))}  obrigado-jetbrains-${version}.zip`,
    `${digest(editors)}  editors.json`,
    "",
  ].join("\n");
  const fetched: string[] = [];
  const fetch = (input: string): Promise<Response> => {
    fetched.push(input);
    if (input.endsWith("/releases/latest")) {
      return Promise.resolve(reply(JSON.stringify({ tag_name: `v${version}` }), input));
    }
    const github = `https://objects.githubusercontent.com/${input.split("/").at(-1)}`;
    if (input.endsWith("/SHA256SUMS.sig")) {
      return Promise.resolve(reply(signSums(new TextEncoder().encode(sums), PEM), github));
    }
    if (input.endsWith("/SHA256SUMS")) return Promise.resolve(reply(sums, github));
    if (input.endsWith("/editors.json")) return Promise.resolve(reply(editors, github));
    if (input.startsWith(ORIGIN) && options.countingDown === true) {
      return Promise.resolve(reply("Bad Gateway", input, false));
    }
    return Promise.resolve(reply(options.zip ?? pluginZip(version), github));
  };
  return { fetch, keys: [KEY], fetched };
}
