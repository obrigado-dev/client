/**
 * `obrigado install --agent jetbrains`, its daily refresh and its uninstall (A43), over IDEs given
 * rather than found and a release faked at `fetch`: one summary line per IDE, the plugin installed
 * from the checked copy on this machine, the record kept when any IDE took it, and an uninstall
 * that turns the line off where it cannot remove the plugin.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClientIntegrations } from "../src/config.ts";
import { configDirectory, pluginsDirectory } from "../src/jetbrains-ides.ts";
import type { JetBrainsIde, Machine } from "../src/jetbrains-ides.ts";
import { HOSTS_COMMENT } from "../src/jetbrains-plugin.ts";
import { localRepositoryUrl } from "../src/jetbrains-repository.ts";
import {
  ideLabels,
  installJetBrainsHost,
  namesList,
  readyIdesLabel,
  refreshJetBrains,
  removeJetBrains,
} from "../src/commands/install-jetbrains.ts";
import type { JetBrainsDeps } from "../src/commands/install-jetbrains.ts";
import { ORIGIN, release } from "./jetbrains-release.ts";
import type { ReleaseOptions } from "./jetbrains-release.ts";

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

const repositoryDir = (): string => join(home, ".obrigado/jetbrains");
const properties = (each: JetBrainsIde): string =>
  join(configDirectory(each, machine()), "idea.properties");

/** The IDEs given, each installing when asked except those named open, and a release to fetch. */
function world(
  ides: readonly JetBrainsIde[],
  open: readonly JetBrainsIde[] = [],
  published: ReleaseOptions = {},
) {
  const said: string[] = [];
  const ran: (readonly string[])[] = [];
  const { fetch, keys } = release(published);
  const deps: JetBrainsDeps = {
    run: async (argv) => {
      ran.push(argv);
      const target = ides.find((each) => each.launcher === argv[0]);
      if (target === undefined || open.includes(target)) {
        return { code: 1, stdout: "Only one instance of IDEA can be run at a time.\n" };
      }
      await holding(target, "0.4.0");
      return { code: 0, stdout: "installed plugin: PluginNode{id=dev.obrigado}\n" };
    },
    origin: ORIGIN,
    machine: machine(),
    backupDir: join(home, ".obrigado/backups"),
    fetch,
    keys,
    current: "0.3.9",
    repositoryDir: repositoryDir(),
    ides,
    say: (line) => said.push(line),
  };
  return { deps, said, ran };
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
      ["done", "IntelliJ IDEA", "plugin 0.4.0 · approve it when IntelliJ IDEA starts"],
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

  test("installs from the checked copy on this machine, and points the IDE at it", async () => {
    await opened(IDEA);
    const { deps, ran } = world([IDEA]);

    await installJetBrainsHost(null, {}, deps);

    const local = localRepositoryUrl(repositoryDir());
    expect(ran).toEqual([[IDEA.launcher, "installPlugins", "dev.obrigado", local]]);
    expect(existsSync(join(repositoryDir(), "obrigado-jetbrains-0.4.0.zip"))).toBe(true);
    expect(await readFile(properties(IDEA), "utf8")).toBe(
      `${HOSTS_COMMENT}\nidea.plugin.hosts=${local}\n`,
    );
  });

  test("starts no IDE when the plugin does not match the signed checksums", async () => {
    await opened(IDEA, PYCHARM);
    await holding(PYCHARM, "0.3.7");
    const { deps, ran } = world([IDEA, PYCHARM, NEW_RIDER], [], {
      zip: new TextEncoder().encode("something else"),
    });
    const integrations: ClientIntegrations = {};

    const results = await installJetBrainsHost(null, integrations, deps);

    expect(results.map((result) => result.row?.detail)).toEqual([
      "failed: checksum mismatch for obrigado-jetbrains-0.4.0.zip: not installed",
      "failed: checksum mismatch for obrigado-jetbrains-0.4.0.zip: not installed",
      "never opened: open it once, then run this again",
    ]);
    expect(ran).toEqual([]);
    expect(integrations.jetbrains).toBeUndefined();
    expect(existsSync(properties(PYCHARM))).toBe(false);
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
            `to install it by hand, add ${ORIGIN}/jetbrains/updatePlugins.xml under Settings → Plugins → ⚙ → Manage Plugin Repositories`,
          ],
        },
      },
    ]);
  });
});

describe("the daily refresh", () => {
  const installed = {
    install_key: "k",
    api_origin: ORIGIN,
    integrations: { jetbrains: { installed: true } },
  };

  test("puts the next release in the repository for the IDEs to offer", async () => {
    await opened(IDEA);
    await installJetBrainsHost(null, {}, world([IDEA]).deps);
    const { deps, said } = world([IDEA], [], { version: "0.4.1" });

    await refreshJetBrains(installed, (line) => said.push(line), deps);

    expect(said).toEqual([
      "JetBrains IDEs: plugin 0.4.1, offered at each IDE's next update check.",
    ]);
    expect(existsSync(join(repositoryDir(), "obrigado-jetbrains-0.4.1.zip"))).toBe(true);
  });

  test("moves an IDE that 0.3.9 pointed at obrigado.dev over to the checked copy", async () => {
    await opened(IDEA);
    await holding(IDEA, "0.3.9");
    const remote = `${ORIGIN}/jetbrains/updatePlugins.xml`;
    await writeFile(properties(IDEA), `${HOSTS_COMMENT}\nidea.plugin.hosts=${remote}\n`);

    await refreshJetBrains(installed, () => {}, world([IDEA]).deps);

    expect(await readFile(properties(IDEA), "utf8")).toBe(
      `${HOSTS_COMMENT}\nidea.plugin.hosts=${localRepositoryUrl(repositoryDir())}\n`,
    );
  });

  test("does nothing for an install that never put the plugin in", async () => {
    const { deps, said } = world([IDEA]);

    await refreshJetBrains(null, (line) => said.push(line), deps);

    expect(said).toEqual([]);
    expect(existsSync(repositoryDir())).toBe(false);
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
    // Nothing points at the copy here any more.
    expect(existsSync(repositoryDir())).toBe(false);
  });
});
