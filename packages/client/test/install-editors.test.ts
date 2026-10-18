/**
 * Whether a bare install puts the line in VS Code, its forks or the JetBrains IDEs too (A40, A43, A47):
 * asked, default no, before anything is installed, and never without somebody there to answer.
 */
import { describe, expect, test } from "bun:test";

import type { ClientConfig } from "../src/config.ts";
import { chooseEditors } from "../src/commands/install-editors.ts";
import type { EditorHere } from "../src/commands/install-editors.ts";

const BOTH: EditorHere[] = [
  { host: "vscode", label: "VS Code" },
  { host: "cursor", label: "Cursor" },
];
const NEITHER: EditorHere[] = [];

/** Answers in order, recording each question it was put. */
function answering(...answers: Array<string | null>): {
  ask: (question: string) => Promise<string | null>;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    ask: (question) => {
      asked.push(question);
      return Promise.resolve(answers[asked.length - 1] ?? null);
    },
    asked,
  };
}

const INSTALLED_IN_VSCODE: ClientConfig = {
  install_key: "k",
  api_origin: "https://obrigado.dev",
  integrations: { vscode: { installed: true } },
};

describe("asking about the editors on this machine", () => {
  test("one question per editor here, and only a yes includes it", async () => {
    const { ask, asked } = answering("y", "");

    expect(await chooseEditors(null, ask, BOTH)).toEqual(["vscode"]);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain("VS Code");
    expect(asked[1]).toContain("Cursor");
    expect(asked[0]).toEndWith("[y/N] ");
  });

  test("an editor already installed into is kept without asking again", async () => {
    const { ask, asked } = answering("");

    expect(await chooseEditors(INSTALLED_IN_VSCODE, ask, BOTH)).toEqual(["vscode"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("Cursor");
  });

  test("with nobody to ask, nothing new is added", async () => {
    expect(await chooseEditors(null, null, BOTH)).toEqual([]);
    expect(await chooseEditors(INSTALLED_IN_VSCODE, null, BOTH)).toEqual(["vscode"]);
  });

  test("an input that ends stops the questions, keeping what was answered", async () => {
    const { ask, asked } = answering("yes", null);

    expect(await chooseEditors(null, ask, BOTH)).toEqual(["vscode"]);
    expect(asked).toHaveLength(2);
  });

  test("an editor that is not here is never asked about", async () => {
    const { ask, asked } = answering("y", "y");

    expect(await chooseEditors(null, ask, NEITHER)).toEqual([]);
    expect(asked).toHaveLength(0);
  });
});

describe("asking about the JetBrains IDEs", () => {
  test("once for all of them, by name, after the other editors", async () => {
    const { ask, asked } = answering("", "", "y");
    const here: EditorHere[] = [...BOTH, { host: "jetbrains", label: "IntelliJ IDEA and PyCharm" }];

    expect(await chooseEditors(null, ask, here)).toEqual(["jetbrains"]);
    expect(asked[2]).toBe(
      "Also put the sponsored line in IntelliJ IDEA and PyCharm? Only while an agent runs there. [y/N] ",
    );
  });

  test("kept without asking once installed", async () => {
    const config: ClientConfig = {
      install_key: "k",
      api_origin: "https://obrigado.dev",
      integrations: { jetbrains: { installed: true } },
    };

    expect(await chooseEditors(config, null, [{ host: "jetbrains", label: "PyCharm" }])).toEqual([
      "jetbrains",
    ]);
  });
});
