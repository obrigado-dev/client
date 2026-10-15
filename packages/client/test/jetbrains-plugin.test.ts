/**
 * The JetBrains plugin's install through the IDE's own `installPlugins` (A43), with the IDE faked
 * at `run`: it unpacks the plugin as the real one does, or answers as an open one does.
 *
 * The claims: the IDE is started only when the plugin is not there yet; the repository goes into
 * the IDE's custom properties so the IDE takes updates from it, beside anybody else's and backed
 * up first; an open IDE writes nothing; and uninstalling takes out only what was added.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Ran } from "../src/editor-extension.ts";
import { configDirectory, pluginsDirectory } from "../src/jetbrains-ides.ts";
import type { JetBrainsIde, Machine } from "../src/jetbrains-ides.ts";
import {
  HOSTS_COMMENT,
  installedPluginVersion,
  installJetBrainsPlugin,
  PLUGIN_ID,
  removeJetBrainsRepository,
  runLauncher,
  withoutRepository,
  withRepository,
} from "../src/jetbrains-plugin.ts";
import type { PluginDeps } from "../src/jetbrains-plugin.ts";

const ORIGIN = "https://obrigado.dev";
const REPOSITORY = `${ORIGIN}/jetbrains/updatePlugins.xml`;

describe("adding the repository to an IDE's custom properties", () => {
  test("starts the setting, with a comment saying whose it is, where there was none", () => {
    expect(withRepository("", REPOSITORY)).toBe(
      `${HOSTS_COMMENT}\nidea.plugin.hosts=${REPOSITORY}\n`,
    );
    expect(withRepository("idea.max.intellisense.filesize=5000", REPOSITORY)).toBe(
      `idea.max.intellisense.filesize=5000\n${HOSTS_COMMENT}\nidea.plugin.hosts=${REPOSITORY}\n`,
    );
  });

  test("joins the hosts somebody already has, in any of the forms the file allows", () => {
    expect(withRepository("idea.plugin.hosts=https://a.example/u.xml\n", REPOSITORY)).toBe(
      `idea.plugin.hosts=https://a.example/u.xml;${REPOSITORY}\n`,
    );
    expect(withRepository("idea.plugin.hosts : https://a.example/u.xml", REPOSITORY)).toBe(
      `idea.plugin.hosts=https://a.example/u.xml;${REPOSITORY}`,
    );
    expect(withRepository("idea.plugin.hosts https://a.example/u.xml", REPOSITORY)).toBe(
      `idea.plugin.hosts=https://a.example/u.xml;${REPOSITORY}`,
    );
  });

  test("edits the last line that sets the hosts, which is the one the IDE keeps", () => {
    const text =
      "idea.plugin.hosts=https://old.example/u.xml\nidea.plugin.hosts=https://a.example/u.xml";
    expect(withRepository(text, REPOSITORY)).toBe(
      `idea.plugin.hosts=https://old.example/u.xml\nidea.plugin.hosts=https://a.example/u.xml;${REPOSITORY}`,
    );
  });

  test("changes nothing when it is already there, and leaves comments alone", () => {
    const text = `# idea.plugin.hosts=https://commented.example\nidea.plugin.hosts=${REPOSITORY}\n`;
    expect(withRepository(text, REPOSITORY)).toBe(text);
  });

  test("refuses a hosts line that runs on over several lines", () => {
    expect(
      withRepository(
        "idea.plugin.hosts=https://a.example/u.xml;\\\n  https://b.example",
        REPOSITORY,
      ),
    ).toBeNull();
  });
});

describe("taking the repository back out", () => {
  test("removes the line and its comment when ours was the only host", () => {
    const text = `idea.max.intellisense.filesize=5000\n${HOSTS_COMMENT}\nidea.plugin.hosts=${REPOSITORY}\n`;
    expect(withoutRepository(text, REPOSITORY)).toBe("idea.max.intellisense.filesize=5000\n");
  });

  test("keeps everybody else's hosts", () => {
    expect(
      withoutRepository(`idea.plugin.hosts=https://a.example/u.xml;${REPOSITORY}`, REPOSITORY),
    ).toBe("idea.plugin.hosts=https://a.example/u.xml");
  });

  test("leaves a file that does not name it as it was", () => {
    const text = "idea.plugin.hosts=https://a.example/u.xml\n";
    expect(withoutRepository(text, REPOSITORY)).toBe(text);
    expect(withoutRepository("", REPOSITORY)).toBe("");
  });

  test("round-trips a file somebody else wrote", () => {
    const text = "# mine\nidea.plugin.hosts=https://a.example/u.xml\nidea.cycle.buffer.size=1024\n";
    expect(withoutRepository(withRepository(text, REPOSITORY) ?? "", REPOSITORY)).toBe(text);
  });
});

let home: string;
let backups: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "obrigado-jetbrains-plugin-"));
  backups = join(home, ".obrigado/backups");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const IDE: JetBrainsIde = {
  name: "IntelliJ IDEA",
  productCode: "IU",
  build: "252.25557.131",
  vendor: "JetBrains",
  dataDirectory: "IntelliJIdea2025.2",
  launcher: "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea",
};

const machine = (): Machine => ({ platform: "darwin", arch: "arm64", home, env: {} });
const properties = (): string => join(configDirectory(IDE, machine()), "idea.properties");

/** The plugin as the IDE's installer leaves it. */
async function unpack(version: string): Promise<void> {
  const lib = join(pluginsDirectory(IDE, machine()), "obrigado-jetbrains/lib");
  await mkdir(lib, { recursive: true });
  await writeFile(join(lib, `obrigado-jetbrains-${version}.jar`), "PK");
}

/** An IDE that answers `installPlugins` with `answer`, unpacking the plugin when it succeeds. */
function ideAnswering(answer: Ran): { deps: PluginDeps; ran: (readonly string[])[] } {
  const ran: (readonly string[])[] = [];
  const deps: PluginDeps = {
    run: async (argv) => {
      ran.push(argv);
      if (answer.code === 0) await unpack("0.3.8");
      return answer;
    },
    origin: ORIGIN,
    machine: machine(),
    backupDir: backups,
  };
  return { deps, ran };
}

const INSTALLED: Ran = {
  code: 0,
  stdout: `plugin repositories: [${REPOSITORY}, null]\nlooking up plugins: [dev.obrigado]\ninstalled plugin: PluginNode{id=dev.obrigado, name='Obrigado'}\n`,
};

beforeEach(async () => {
  // An IDE that has been opened has settings, and maybe custom properties of its own.
  await mkdir(join(configDirectory(IDE, machine()), "options"), { recursive: true });
});

describe("installing into an IDE", () => {
  test("runs the IDE's installer against the repository, then remembers the repository", async () => {
    const { deps, ran } = ideAnswering(INSTALLED);

    const outcome = await installJetBrainsPlugin(IDE, deps);

    expect(ran).toEqual([[IDE.launcher, "installPlugins", PLUGIN_ID, REPOSITORY]]);
    expect(outcome).toEqual({ status: "installed", version: "0.3.8", updates: true, backup: null });
    expect(await readFile(properties(), "utf8")).toBe(
      `${HOSTS_COMMENT}\nidea.plugin.hosts=${REPOSITORY}\n`,
    );
  });

  test("backs up custom properties that were there before changing them", async () => {
    await writeFile(properties(), "idea.max.intellisense.filesize=5000\n");
    const { deps } = ideAnswering(INSTALLED);

    const outcome = await installJetBrainsPlugin(IDE, deps);

    expect(outcome.status === "installed" ? outcome.backup : null).not.toBeNull();
    const saved = await readdir(backups);
    expect(saved).toHaveLength(1);
    expect(await readFile(join(backups, saved[0] ?? ""), "utf8")).toBe(
      "idea.max.intellisense.filesize=5000\n",
    );
  });

  test("does not start the IDE when the plugin is already there, so an open one is fine", async () => {
    await unpack("0.3.7");
    const { deps, ran } = ideAnswering({
      code: 1,
      stdout: "Only one instance of IDEA can be run at a time.\n",
    });

    const outcome = await installJetBrainsPlugin(IDE, deps);

    expect(ran).toEqual([]);
    expect(outcome).toEqual({
      status: "already-installed",
      version: "0.3.7",
      updates: true,
      backup: null,
    });
    expect(await readFile(properties(), "utf8")).toContain(REPOSITORY);
  });

  test("writes nothing when the IDE is open, and says so", async () => {
    const { deps } = ideAnswering({
      code: 1,
      stdout: "Only one instance of IDEA can be run at a time.\n",
    });

    expect(await installJetBrainsPlugin(IDE, deps)).toEqual({
      status: "open",
      reason: "Only one instance of IDEA can be run at a time.",
    });
    expect(await Bun.file(properties()).exists()).toBe(false);
  });

  test("an IDE still starting up counts as open", async () => {
    const { deps } = ideAnswering({ code: 14, stdout: "IDE has not been initialized yet\n" });
    expect((await installJetBrainsPlugin(IDE, deps)).status).toBe("open");
  });

  test("passes on what the IDE said when it could not install", async () => {
    const { deps } = ideAnswering({
      code: 1,
      stdout: `plugin repositories: [${REPOSITORY}, null]\nlooking up plugins: [dev.obrigado]\nunknown plugins: [dev.obrigado]\n`,
    });

    expect(await installJetBrainsPlugin(IDE, deps)).toEqual({
      status: "failed",
      reason: "unknown plugins: [dev.obrigado]",
    });
  });

  test("still installs when the hosts line cannot be edited, and says updates need a hand", async () => {
    const text = "idea.plugin.hosts=https://a.example/u.xml;\\\n  https://b.example\n";
    await writeFile(properties(), text);
    const { deps } = ideAnswering(INSTALLED);

    const outcome = await installJetBrainsPlugin(IDE, deps);

    expect(outcome.status === "installed" && outcome.updates).toBe(false);
    expect(await readFile(properties(), "utf8")).toBe(text);
  });
});

describe("uninstalling from an IDE", () => {
  test("takes out only the repository it added, once", async () => {
    await writeFile(properties(), `idea.plugin.hosts=https://a.example/u.xml;${REPOSITORY}\n`);
    const { deps } = ideAnswering(INSTALLED);

    expect(await removeJetBrainsRepository(IDE, deps)).toBe(true);
    expect(await readFile(properties(), "utf8")).toBe(
      "idea.plugin.hosts=https://a.example/u.xml\n",
    );
    expect(await removeJetBrainsRepository(IDE, deps)).toBe(false);
  });
});

describe("reading what is installed", () => {
  test("names the version by its jar", async () => {
    expect(installedPluginVersion(pluginsDirectory(IDE, machine()))).toBeNull();
    await unpack("0.4.0");
    expect(installedPluginVersion(pluginsDirectory(IDE, machine()))).toBe("0.4.0");
  });
});

describe("running the launcher", () => {
  test("returns what it printed and how it exited", async () => {
    expect(
      await runLauncher(["/bin/sh", "-c", "echo installed plugin; echo noise >&2; exit 3"]),
    ).toEqual({
      code: 3,
      stdout: "installed plugin\n",
    });
  });
});
