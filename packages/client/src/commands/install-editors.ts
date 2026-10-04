/**
 * VS Code and Cursor: the extension's question, install, removal and refresh (A40).
 *
 * Split from `install.ts` for its line budget, as the Pi and desktop app adapters were. What is
 * fetched, checked and handed to the editor lives in `editor-extension.ts`; these decide what the
 * developer is asked and told, and what the install records.
 */
import { createInterface } from "node:readline/promises";

import { editorIntegration } from "../config.ts";
import type { ClientConfig, ClientIntegrations } from "../config.ts";
import {
  EDITORS,
  editorPresent,
  installEditorExtension,
  runTool,
  uninstallEditorExtension,
} from "../editor-extension.ts";
import type { Editor, EditorDeps } from "../editor-extension.ts";
import { CLIENT_VERSION } from "../version.ts";
import type { AdapterResult, Remover } from "./adapters.ts";
import { canAsk, parseAnswer } from "./privacy-prompt.ts";
import { apiOrigin } from "./shared.ts";

const LABEL: Record<Editor, string> = { vscode: "VS Code", cursor: "Cursor" };

type Ask = (question: string) => Promise<string | null>;

/**
 * The editors a bare install includes: those it already put the extension in, then those
 * somebody says yes to now.
 *
 * Never unasked. An editor on the machine says nothing about whether an agent runs in it, so
 * one that is here is a question, default no, put before anything is installed so the answers
 * come first and their rows join the rest. Without anybody to ask (`ask` null) only the ones
 * already installed are kept. An input that ends stops the questions, not the install.
 */
export async function chooseEditors(
  existing: ClientConfig | null,
  ask: Ask | null,
  present: (editor: Editor) => boolean = editorPresent,
): Promise<Editor[]> {
  const chosen: Editor[] = [];
  for (const editor of EDITORS.filter((candidate) => present(candidate))) {
    if (editorIntegration(existing, editor)?.installed === true) {
      chosen.push(editor);
      continue;
    }
    if (ask === null) continue;
    const question = `Also put the sponsored line in ${LABEL[editor]}? Only while an agent runs there. [y/N] `;
    // oxlint-disable-next-line eslint/no-await-in-loop -- a person answers one question at a time
    const answer = parseAnswer(await ask(question));
    if (answer === null) break;
    if (answer) chosen.push(editor);
  }
  return chosen;
}

/** `chooseEditors` on the real terminal, or with no questions where nobody can answer. */
export async function editorsForInstall(
  argv: readonly string[],
  existing: ClientConfig | null,
): Promise<Editor[]> {
  if (!canAsk(argv)) return chooseEditors(existing, null);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new AbortController();
  rl.on("close", () => closed.abort());
  rl.on("SIGINT", () => rl.close());
  try {
    return await chooseEditors(existing, async (question) => {
      try {
        return await rl.question(question, { signal: closed.signal });
      } catch {
        return null;
      }
    });
  } finally {
    rl.close();
  }
}

function editorDeps(config: ClientConfig | null): EditorDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    current: CLIENT_VERSION,
    run: runTool,
    origin: apiOrigin(config),
  };
}

async function installEditorAdapter(
  editor: Editor,
  existing: ClientConfig | null,
  integrations: ClientIntegrations,
  deps: EditorDeps,
): Promise<AdapterResult> {
  const outcome = await installEditorExtension(editor, deps);
  if (outcome.status === "failed") {
    return {
      changed: false,
      failed: true,
      row: { mark: "failed", host: LABEL[editor], detail: `failed: ${outcome.reason}` },
    };
  }
  integrations[editor] = {
    installed: true,
    installed_at: editorIntegration(existing, editor)?.installed_at ?? new Date().toISOString(),
  };
  const already = outcome.status === "already-installed";
  return {
    changed: true,
    failed: false,
    row: {
      mark: "done",
      host: LABEL[editor],
      detail: `extension ${outcome.version} · ${already ? "already there" : "reload the window"}`,
    },
  };
}

/** Each editor asked for, in the table's order. */
export async function installEditorHosts(
  targets: readonly string[],
  existing: ClientConfig | null,
  integrations: ClientIntegrations,
  deps: EditorDeps = editorDeps(existing),
): Promise<AdapterResult[]> {
  const results: AdapterResult[] = [];
  for (const editor of EDITORS.filter((candidate) => targets.includes(candidate))) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- two editors, each with its own tool
    results.push(await installEditorAdapter(editor, existing, integrations, deps));
  }
  return results;
}

export function removeEditor(editor: Editor): Remover {
  return async (config, integrations) => {
    const result = await uninstallEditorExtension(editor, { run: runTool });
    console.log(
      result === "removed"
        ? `${LABEL[editor]}: removed the Obrigado extension.`
        : `${LABEL[editor]}: no Obrigado extension found.`,
    );
    integrations[editor] = {
      ...(editorIntegration(config, editor) ?? { installed: false }),
      installed: false,
    };
  };
}

/**
 * The newest release's extension, in every editor this install put one in.
 *
 * A sideloaded extension does not update itself, so `obrigado update` runs this after the binary.
 * An editor whose extension is current is skipped without a download.
 */
export async function refreshEditors(
  config: ClientConfig | null,
  say: (line: string) => void,
  deps: EditorDeps = editorDeps(config),
): Promise<void> {
  for (const editor of EDITORS) {
    if (editorIntegration(config, editor)?.installed !== true) continue;
    // oxlint-disable-next-line eslint/no-await-in-loop -- two editors, each with its own tool
    const outcome = await installEditorExtension(editor, deps);
    if (outcome.status === "installed") say(`${LABEL[editor]}: extension ${outcome.version}.`);
    if (outcome.status === "failed") say(`${LABEL[editor]}: not updated: ${outcome.reason}.`);
  }
}
