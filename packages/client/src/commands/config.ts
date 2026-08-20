import { BATCH_PATH, OBRIGADO_DIR, readConfig, writeConfig } from "../config.ts";
import type { ClientConfig } from "../config.ts";
import { supportsHyperlinks } from "../link.ts";
import { supportsColor } from "../style.ts";
import { clearSessionBatches } from "../session-state.ts";
import { apiOrigin } from "./shared.ts";

/**
 * Settings a developer may change, and what each accepts.
 *
 * `color` exists so the developer's terminal stays theirs — which is undermined
 * if exercising it means hand-editing JSON. Every setting that claims to respect
 * them needs a way to be set that respects them too.
 */
const SETTINGS = {
  color: {
    values: ["auto", "off"],
    describe: "colour for the sponsored copy; `off` overrides any advertiser choice",
  },
  api_origin: {
    values: null,
    describe: "which Obrigado server to talk to",
  },
  session_summary: {
    values: ["true", "false"],
    describe: "end-of-session summary line (§14 Phase 1; not yet rendered)",
  },
} as const;

type SettingName = keyof typeof SETTINGS;

function isSettingName(value: string): value is SettingName {
  return Object.hasOwn(SETTINGS, value);
}

function show(current: ClientConfig): void {
  console.log(`Settings — ${OBRIGADO_DIR}/config.json\n`);
  console.log(`  color            ${current.color ?? "auto"}`);
  console.log(`  api_origin       ${apiOrigin(current)}`);
  console.log(`  session_summary  ${current.session_summary ?? true}`);

  console.log("\n  Effective right now, in this terminal:");
  console.log(
    `    colour       ${supportsColor(process.env, current.color ?? "auto") ? "on" : "off"}`,
  );
  console.log(`    clickable    ${supportsHyperlinks() ? "on" : "off"}`);

  console.log("\n  These environment variables win over the file:");
  console.log("    NO_COLOR=1              disable colour (https://no-color.org)");
  console.log("    OBRIGADO_HYPERLINKS=0    disable clickable copy");
  console.log("    OBRIGADO_API_ORIGIN=…    override the server");

  console.log("\n  obrigado config <name> <value>   to change one");
  for (const [name, spec] of Object.entries(SETTINGS)) {
    const accepts = spec.values === null ? "<value>" : spec.values.join(" | ");
    console.log(`    ${name.padEnd(16)} ${accepts.padEnd(14)} ${spec.describe}`);
  }
}

export async function config(): Promise<number> {
  const existing = await readConfig();
  if (existing === null) {
    console.log("Obrigado is not installed. Run `obrigado install`.");
    return 1;
  }

  const [, , , name, value] = process.argv;
  if (name === undefined) {
    show(existing);
    return 0;
  }

  if (!isSettingName(name)) {
    console.error(`Unknown setting "${name}". Known: ${Object.keys(SETTINGS).join(", ")}`);
    return 1;
  }

  const spec = SETTINGS[name];
  if (value === undefined) {
    console.error(`Usage: obrigado config ${name} <${spec.values?.join("|") ?? "value"}>`);
    return 1;
  }
  if (spec.values !== null && !(spec.values as readonly string[]).includes(value)) {
    console.error(`"${value}" is not valid for ${name}. Accepts: ${spec.values.join(", ")}`);
    return 1;
  }

  const next: ClientConfig = { ...existing };
  switch (name) {
    case "color":
      await writeConfig({ ...next, color: value === "off" ? "off" : "auto" });
      break;
    case "api_origin":
      await writeConfig({ ...next, api_origin: value });
      break;
    case "session_summary":
      await writeConfig({ ...next, session_summary: value === "true" });
      break;
  }

  console.log(`${name} = ${value}`);
  return 0;
}

/**
 * Discard the cached batch.
 *
 * The client caches a batch for its TTL (15 minutes) so the status-line hot path
 * never blocks on the network. That is right for rendering and wrong for
 * iterating: after changing a campaign's targeting or bid, waiting a quarter of
 * an hour to see whether it worked makes the product feel broken. This forces
 * the next render to fetch.
 */
export async function refresh(): Promise<number> {
  const existing = await readConfig();
  if (existing === null) {
    console.log("Obrigado is not installed. Run `obrigado install`.");
    return 1;
  }

  const cleared = await clearSessionBatches();
  const file = Bun.file(BATCH_PATH);
  if (await file.exists()) {
    await Bun.write(BATCH_PATH, "");
  }
  if (cleared > 0 || (await file.exists())) {
    console.log(`Discarded ${cleared} session batch(es) — the next render will fetch anew.`);
  } else {
    console.log("No cached batch; the next render fetches anyway.");
  }
  return 0;
}
