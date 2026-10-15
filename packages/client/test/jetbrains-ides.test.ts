/**
 * Finding the JetBrains IDEs on a machine by their `product-info.json` (A43), against a scratch
 * tree laid out as the IDEs' installers and the Toolbox App lay them out.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  configDirectory,
  inJetBrainsTerminal,
  jetbrainsIdes,
  pluginsDirectory,
  readiness,
  SINCE_BUILD,
  SINCE_RELEASE,
} from "../src/jetbrains-ides.ts";
import type { JetBrainsIde, Machine } from "../src/jetbrains-ides.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "obrigado-jetbrains-ides-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const mac = (): Machine => ({
  platform: "darwin",
  arch: "arm64",
  home: join(root, "home"),
  env: {},
});
const linux = (env: Record<string, string> = {}): Machine => ({
  platform: "linux",
  arch: "x64",
  home: join(root, "home"),
  env,
});

interface Product {
  readonly name?: string;
  readonly code?: string;
  readonly build?: string;
  readonly data?: string;
  readonly vendor?: string;
  readonly launch?: ReadonlyArray<{ os: string; arch?: string; launcherPath: string }>;
}

async function touch(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
}

/** An IDE's `product-info.json` at `file`, with the launchers it names. */
async function product(file: string, made: Product = {}): Promise<void> {
  const launch = made.launch ?? [{ os: "macOS", arch: "aarch64", launcherPath: "../MacOS/idea" }];
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      name: made.name ?? "IntelliJ IDEA",
      buildNumber: made.build ?? "252.25557.131",
      productCode: made.code ?? "IU",
      dataDirectoryName: made.data ?? "IntelliJIdea2025.2",
      ...(made.vendor === undefined ? {} : { productVendor: made.vendor }),
      launch,
    }),
  );
  await Promise.all(launch.map((entry) => touch(join(dirname(file), entry.launcherPath))));
}

/** A macOS app bundle under `dir`. */
async function app(dir: string, bundle: string, made: Product = {}): Promise<void> {
  await product(join(dir, bundle, "Contents/Resources/product-info.json"), made);
}

describe("finding the IDEs", () => {
  test("reads an app bundle, and resolves its launcher from the bundle", async () => {
    await app(join(root, "Applications"), "IntelliJ IDEA.app");

    const [ide, ...rest] = jetbrainsIdes(mac(), [[join(root, "Applications"), 1]]);

    expect(rest).toEqual([]);
    expect(ide).toEqual({
      name: "IntelliJ IDEA",
      productCode: "IU",
      build: "252.25557.131",
      vendor: "JetBrains",
      dataDirectory: "IntelliJIdea2025.2",
      launcher: join(root, "Applications/IntelliJ IDEA.app/Contents/MacOS/idea"),
    });
  });

  test("finds the Toolbox App's nested copies within the depth given, and no deeper", async () => {
    const apps = join(root, "Toolbox/apps");
    await app(join(apps, "PyCharm-P/ch-0/252.1"), "PyCharm.app", {
      name: "PyCharm",
      code: "PY",
      data: "PyCharm2025.2",
    });

    expect(jetbrainsIdes(mac(), [[apps, 4]]).map((ide) => ide.name)).toEqual(["PyCharm"]);
    expect(jetbrainsIdes(mac(), [[apps, 3]])).toEqual([]);
  });

  test("reads a Linux install, with the launcher for this architecture", async () => {
    await product(join(root, "opt/idea-IU-252/product-info.json"), {
      launch: [
        { os: "Linux", arch: "aarch64", launcherPath: "bin/idea-arm" },
        { os: "Linux", arch: "amd64", launcherPath: "bin/idea" },
      ],
    });

    const [ide] = jetbrainsIdes(linux(), [[join(root, "opt"), 1]]);

    expect(ide?.launcher).toBe(join(root, "opt/idea-IU-252/bin/idea"));
  });

  test("skips thin clients, IDEs with no launcher here, and files that are not an IDE's", async () => {
    const dir = join(root, "Applications");
    await app(dir, "JetBrains Gateway.app", {
      name: "JetBrains Gateway",
      code: "GW",
      data: "JetBrainsGateway2025.2",
    });
    await app(dir, "Linux Only.app", {
      data: "Other2025.2",
      launch: [{ os: "Linux", launcherPath: "bin/idea" }],
    });
    await mkdir(join(dir, "Broken.app/Contents/Resources"), { recursive: true });
    await writeFile(join(dir, "Broken.app/Contents/Resources/product-info.json"), "{not json");

    expect(jetbrainsIdes(mac(), [[dir, 1]])).toEqual([]);
  });

  test("lists two installs of one version once, since they share settings and plugins", async () => {
    await app(join(root, "a"), "IntelliJ IDEA.app");
    await app(join(root, "b"), "IntelliJ IDEA Copy.app");

    const found = jetbrainsIdes(mac(), [
      [join(root, "a"), 1],
      [join(root, "b"), 1],
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]?.launcher).toContain(join(root, "a"));
  });

  test("takes Android Studio's own vendor folder", async () => {
    await app(join(root, "Applications"), "Android Studio.app", {
      name: "Android Studio",
      code: "AI",
      build: "261.26222.65.2613.15948027",
      data: "AndroidStudio2026.1.3",
      vendor: "Google",
      launch: [{ os: "macOS", arch: "aarch64", launcherPath: "../MacOS/studio" }],
    });

    const [ide] = jetbrainsIdes(mac(), [[join(root, "Applications"), 1]]);

    expect(ide?.vendor).toBe("Google");
    expect(configDirectory(ide as JetBrainsIde, mac())).toBe(
      join(root, "home/Library/Application Support/Google/AndroidStudio2026.1.3"),
    );
  });
});

const IDE: JetBrainsIde = {
  name: "IntelliJ IDEA",
  productCode: "IU",
  build: "252.25557.131",
  vendor: "JetBrains",
  dataDirectory: "IntelliJIdea2025.2",
  launcher: "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea",
};

describe("where an IDE keeps its settings and plugins", () => {
  test("on macOS, the plugins inside the settings", () => {
    const settings = join(root, "home/Library/Application Support/JetBrains/IntelliJIdea2025.2");
    expect(configDirectory(IDE, mac())).toBe(settings);
    expect(pluginsDirectory(IDE, mac())).toBe(join(settings, "plugins"));
  });

  test("on Linux, settings in the config folder and plugins in the data folder", () => {
    expect(configDirectory(IDE, linux())).toBe(
      join(root, "home/.config/JetBrains/IntelliJIdea2025.2"),
    );
    expect(pluginsDirectory(IDE, linux())).toBe(
      join(root, "home/.local/share/JetBrains/IntelliJIdea2025.2"),
    );
  });

  test("on Linux, wherever the XDG variables move them", () => {
    const moved = linux({ XDG_CONFIG_HOME: "/x/config", XDG_DATA_HOME: "/x/data" });
    expect(configDirectory(IDE, moved)).toBe("/x/config/JetBrains/IntelliJIdea2025.2");
    expect(pluginsDirectory(IDE, moved)).toBe("/x/data/JetBrains/IntelliJIdea2025.2");
  });
});

describe("whether the plugin can go in now", () => {
  test("not into a release older than the plugin claims", () => {
    expect(readiness({ ...IDE, build: "243.26053.27" }, mac())).toBe("too-old");
  });

  test("not into one never opened, whose first start would then skip importing settings", () => {
    expect(readiness(IDE, mac())).toBe("never-opened");
  });

  test("into one that has been opened", async () => {
    await mkdir(join(configDirectory(IDE, mac()), "options"), { recursive: true });
    expect(readiness(IDE, mac())).toBe("ready");
  });

  test("the oldest release claimed is the plugin's own", async () => {
    const plugin = new URL("../../jetbrains-plugin/", import.meta.url).pathname;
    const build = await readFile(join(plugin, "build.gradle.kts"), "utf8");
    const properties = await readFile(join(plugin, "gradle.properties"), "utf8");

    expect(build).toContain(`sinceBuild = "${String(SINCE_BUILD)}"`);
    expect(properties).toContain(`platformVersion = ${SINCE_RELEASE}`);
  });
});

describe("a JetBrains IDE's own terminal", () => {
  test("is told apart by the variable every IDE sets in it", () => {
    expect(
      inJetBrainsTerminal({ ...mac(), env: { TERMINAL_EMULATOR: "JetBrains-JediTerm" } }),
    ).toBe(true);
    expect(inJetBrainsTerminal({ ...mac(), env: { TERM_PROGRAM: "iTerm.app" } })).toBe(false);
  });
});
