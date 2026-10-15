/**
 * `obrigado install --agent jetbrains` and its uninstall (A43), over IDEs given rather than found:
 * one summary line per IDE, the record kept when any took the plugin, and an uninstall that turns
 * the line off where it cannot remove the plugin.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClientIntegrations } from "../src/config.ts";
import { configDirectory, pluginsDirectory } from "../src/jetbrains-ides.ts";
import type { JetBrainsIde, Machine } from "../src/jetbrains-ides.ts";
import {
  ideLabels,
  installJetBrainsHost,
  namesList,
  readyIdesLabel,
  removeJetBrains,
} from "../src/commands/install-jetbrains.ts";
import type { JetBrainsDeps } from "../src/commands/install-jetbrains.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "obrigado-install-jetbrains-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function ide(name: string, dataDirectory: string, build = "252.25557.131"): JetBrainsIde {
  return {
    name,
    productCode: "IU",
    build,
    vendor: "JetBrains",
    dataDirectory,
    launcher: `/Applications/${name}.app/Contents/MacOS/idea`,
  };
}

const IDEA = ide("IntelliJ IDEA", "IntelliJIdea2025.2");
const PYCHARM = ide("PyCharm", "PyCharm2025.2");
const WEBSTORM = ide("WebStorm", "WebStorm2025.2");
const OLD_GOLAND = ide("GoLand", "GoLand2024.3", "243.26053.27");
const NEW_RIDER = ide("Rider", "Rider2025.2");

const machine = (): Machine => ({ platform: "darwin", arch: "arm64", home, env: {} });

async function opened(...ides: JetBrainsIde[]): Promise<void> {
  await Promise.all(
    ides.map((each) =>
      mkdir(join(configDirectory(each, machine()), "options"), { recursive: true }),
    ),
  );
}

async function holding(each: JetBrainsIde, version: string): Promise<void> {
  const lib = join(pluginsDirectory(each, machine()), "obrigado-jetbrains/lib");
  await mkdir(lib, { recursive: true });
  await writeFile(join(lib, `obrigado-jetbrains-${version}.jar`), "PK");
}

/** The IDEs given, each installing when asked, except those named open. */
function world(ides: readonly JetBrainsIde[], open: readonly JetBrainsIde[] = []) {
  const said: string[] = [];
  const deps: JetBrainsDeps = {
    run: async (argv) => {
      const target = ides.find((each) => each.launcher === argv[0]);
      if (target === undefined || open.includes(target)) {
        return { code: 1, stdout: "Only one instance of IDEA can be run at a time.\n" };
      }
      await holding(target, "0.3.8");
      return { code: 0, stdout: "installed plugin: PluginNode{id=dev.obrigado}\n" };
    },
    origin: "https://obrigado.dev",
    machine: machine(),
    backupDir: join(home, ".obrigado/backups"),
    ides,
    say: (line) => said.push(line),
  };
  return { deps, said };
}

describe("naming the IDEs", () => {
  test("by name, with the version only where two share one", () => {
    expect(ideLabels([IDEA, PYCHARM])).toEqual(["IntelliJ IDEA", "PyCharm"]);
    expect(ideLabels([ide("IntelliJ IDEA", "IntelliJIdea2025.1"), IDEA])).toEqual([
      "IntelliJ IDEA 2025.1",
      "IntelliJ IDEA 2025.2",
    ]);
  });

  test("as a list a person reads", () => {
    expect(namesList(["IntelliJ IDEA"])).toBe("IntelliJ IDEA");
    expect(namesList(["IntelliJ IDEA", "PyCharm", "WebStorm"])).toBe(
      "IntelliJ IDEA, PyCharm and WebStorm",
    );
  });

  test("a bare install asks only about the IDEs the plugin can go into now", async () => {
    await opened(IDEA, PYCHARM, OLD_GOLAND);
    const { deps } = world([IDEA, PYCHARM, OLD_GOLAND, NEW_RIDER]);

    expect(readyIdesLabel(deps)).toBe("IntelliJ IDEA and PyCharm");
    expect(readyIdesLabel(world([OLD_GOLAND, NEW_RIDER]).deps)).toBeNull();
  });
});

describe("installing into each IDE", () => {
  test("one line each: installed, already there, open, too old, never opened", async () => {
    await opened(IDEA, PYCHARM, WEBSTORM, OLD_GOLAND);
    await holding(PYCHARM, "0.3.7");
    const { deps, said } = world([IDEA, PYCHARM, WEBSTORM, OLD_GOLAND, NEW_RIDER], [WEBSTORM]);
    const integrations: ClientIntegrations = {};

    const results = await installJetBrainsHost(null, integrations, deps);

    expect(
      results.map((result) => [result.row?.mark, result.row?.host, result.row?.detail]),
    ).toEqual([
      ["done", "IntelliJ IDEA", "plugin 0.3.8 · approve it when IntelliJ IDEA starts"],
      ["done", "PyCharm", "plugin 0.3.7 · already there"],
      ["failed", "WebStorm", "open, so not installed"],
      ["skipped", "GoLand", "needs 2025.1 or newer"],
      ["skipped", "Rider", "never opened: open it once, then run this again"],
    ]);
    expect(results.map((result) => result.failed)).toEqual([false, false, true, false, false]);
    expect(integrations.jetbrains?.installed).toBe(true);
    // Said before the two IDEs that start, and not before the one already holding the plugin.
    expect(said).toEqual([
      "Installing the plugin into IntelliJ IDEA, which starts without a window to do it…",
      "Installing the plugin into WebStorm, which starts without a window to do it…",
    ]);
  });

  test("records nothing when no IDE took the plugin", async () => {
    await opened(WEBSTORM);
    const integrations: ClientIntegrations = {};

    const results = await installJetBrainsHost(
      null,
      integrations,
      world([WEBSTORM], [WEBSTORM]).deps,
    );

    expect(results[0]?.row?.notes).toEqual([
      "quit it, then run `obrigado install --agent jetbrains` again",
    ]);
    expect(integrations.jetbrains).toBeUndefined();
  });

  test("with no IDE found, says how to do it by hand", async () => {
    const results = await installJetBrainsHost(null, {}, world([]).deps);

    expect(results).toEqual([
      {
        changed: false,
        failed: true,
        row: {
          mark: "failed",
          host: "JetBrains IDEs",
          detail: "none found",
          notes: [
            "to install it by hand, add https://obrigado.dev/jetbrains/updatePlugins.xml under Settings → Plugins → ⚙ → Manage Plugin Repositories",
          ],
        },
      },
    ]);
  });
});

describe("uninstalling", () => {
  test("takes the repository out of every IDE, turns the line off, and names where the plugin stays", async () => {
    await opened(IDEA, PYCHARM);
    const { deps } = world([IDEA, PYCHARM]);
    const integrations: ClientIntegrations = {};
    await installJetBrainsHost(null, integrations, deps);
    const { deps: later, said } = world([IDEA, PYCHARM]);

    await removeJetBrains(() => later)(
      { install_key: "k", api_origin: "https://obrigado.dev", integrations },
      integrations,
    );

    expect(integrations.jetbrains?.installed).toBe(false);
    expect(said).toEqual([
      "JetBrains IDEs: the plugin draws nothing now. Remove it in Settings → Plugins in IntelliJ IDEA and PyCharm.",
    ]);
    const left = await Promise.all(
      [IDEA, PYCHARM].map((each) =>
        readFile(join(configDirectory(each, machine()), "idea.properties"), "utf8"),
      ),
    );
    expect(left).toEqual(["", ""]);
  });
});
