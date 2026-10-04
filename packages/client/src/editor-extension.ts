/**
 * The VS Code extension, in VS Code and in Cursor (A40).
 *
 * Neither store lists it yet, so the CLI installs the `.vsix` each release carries: fetched
 * through obrigado.dev, which counts the download and redirects to GitHub, checked against the
 * release's signed SHA256SUMS like the binary the self-update takes, and handed to the editor's
 * own `--install-extension`. Nothing of the editor's is written by hand.
 *
 * A sideloaded extension does not update itself, so `obrigado update` installs the new build
 * after the binary's; `installEditorExtension` does nothing when the installed one is current.
 */
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { latestReleaseTag, verifiedAsset } from "./release-assets.ts";
import type { ReleaseDeps } from "./release-assets.ts";

export type Editor = "vscode" | "cursor";

export const EDITORS: readonly Editor[] = ["vscode", "cursor"];

/** `publisher.name` from the extension's manifest, which is what the editors key it by. */
export const EXTENSION_ID = "obrigado.obrigado-vscode";

const COMMAND: Record<Editor, string> = { vscode: "code", cursor: "cursor" };

/** Where each app keeps its command-line tool on macOS, for an editor never put on PATH. */
const MAC_TOOL: Record<Editor, string> = {
  vscode: "Visual Studio Code.app/Contents/Resources/app/bin/code",
  cursor: "Cursor.app/Contents/Resources/app/bin/cursor",
};

/** The editor's command-line tool: on PATH, or inside the app on macOS. */
function editorCli(editor: Editor): string | null {
  const onPath = Bun.which(COMMAND[editor]);
  if (onPath !== null) return onPath;
  if (process.platform !== "darwin") return null;
  for (const root of ["/Applications", join(homedir(), "Applications")]) {
    const tool = join(root, MAC_TOOL[editor]);
    if (existsSync(tool)) return tool;
  }
  return null;
}

/** Whether `editor` is on this machine: its tool is on PATH or inside its app. */
export function editorPresent(editor: Editor): boolean {
  return editorCli(editor) !== null;
}

export interface Ran {
  readonly code: number;
  readonly stdout: string;
}

export interface EditorDeps extends ReleaseDeps {
  /** Runs the editor's tool. */
  readonly run: (argv: readonly string[]) => Promise<Ran>;
  /** The server to fetch through, so the download is counted. */
  readonly origin: string;
  /** The tool itself; looked up when not given. Null is an editor that is not here. */
  readonly cli?: string | null;
}

export async function runTool(argv: readonly string[]): Promise<Ran> {
  const proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
}

/** The version of ours the editor has installed, or null. */
export async function installedVersion(
  cli: string,
  run: EditorDeps["run"],
): Promise<string | null> {
  const listed = await run([cli, "--list-extensions", "--show-versions"]);
  if (listed.code !== 0) return null;
  for (const line of listed.stdout.split("\n")) {
    const [id, version] = line.trim().split("@");
    if (id?.toLowerCase() === EXTENSION_ID && version !== undefined) return version;
  }
  return null;
}

export type EditorInstallOutcome =
  | { readonly status: "installed" | "already-installed"; readonly version: string }
  | { readonly status: "failed"; readonly reason: string };

/** The latest release's extension in `editor`, unless that version is already there. */
export async function installEditorExtension(
  editor: Editor,
  deps: EditorDeps,
): Promise<EditorInstallOutcome> {
  const cli = deps.cli === undefined ? editorCli(editor) : deps.cli;
  if (cli === null) return { status: "failed", reason: `\`${COMMAND[editor]}\` was not found` };

  const tag = await latestReleaseTag(deps);
  if (tag === null) return { status: "failed", reason: "could not read the latest release" };
  const version = tag.replace(/^v/u, "");
  if ((await installedVersion(cli, deps.run)) === version) {
    return { status: "already-installed", version };
  }

  // Through obrigado.dev first, so the download is counted; GitHub's own URL if that cannot
  // answer. Either way the bytes are held to the signed checksums.
  const asset = `obrigado-vscode-${version}.vsix`;
  const counted = `${deps.origin}/vscode/download/${version}?via=cli`;
  let fetched = await verifiedAsset(deps, tag, asset, counted);
  if (!fetched.ok && fetched.reason.startsWith("could not download")) {
    fetched = await verifiedAsset(deps, tag, asset);
  }
  if (!fetched.ok) return { status: "failed", reason: fetched.reason };

  // The editors read the file by its extension, so it keeps the asset's name.
  const file = join(tmpdir(), `${process.pid}-${asset}`);
  try {
    await writeFile(file, fetched.bytes);
    const installed = await deps.run([cli, "--install-extension", file, "--force"]);
    if (installed.code !== 0) {
      return { status: "failed", reason: `${COMMAND[editor]} --install-extension failed` };
    }
  } finally {
    await rm(file, { force: true });
  }
  return { status: "installed", version };
}

export async function uninstallEditorExtension(
  editor: Editor,
  deps: Pick<EditorDeps, "run" | "cli">,
): Promise<"removed" | "not-installed"> {
  const cli = deps.cli === undefined ? editorCli(editor) : deps.cli;
  if (cli === null || (await installedVersion(cli, deps.run)) === null) return "not-installed";
  const removed = await deps.run([cli, "--uninstall-extension", EXTENSION_ID]);
  return removed.code === 0 ? "removed" : "not-installed";
}
