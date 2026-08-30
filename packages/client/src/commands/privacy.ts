/**
 * `obrigado privacy` — what advertisers may target you on.
 *
 * ## The bargain, and why it is not a payment
 *
 * Everything here is off by default and none of it earns the developer anything. That is
 * deliberate and it is §3's load-bearing property: the developer earns nothing from a
 * sponsored line, which is what makes farming impressions pointless. Paying for consent would
 * put the incentive back.
 *
 * What opting in does is make the inventory worth more, and 70% of what an advertiser pays
 * lands in the open-source packages already in that developer's own lockfile. So the honest
 * pitch is the indirect one — your dependencies earn more — and it is the only one on offer.
 *
 * ## Three settings, not a level
 *
 * They are independent because the concerns are: somebody may be happy to say which country
 * they are in and not what their agent has been reading, or the reverse. A single 0–3 scale
 * would present that as a hierarchy of trust, and it is not one — `network` stores nothing at
 * all while `region` stores a country, so the "higher" setting holds less data.
 *
 * ## Turning one off erases
 *
 * The setting travels on every session, so the server sees the change on the next render
 * rather than at some later sync — and it nulls what it had stored rather than merely
 * declining to read it. Saying no is not "stop using this", it is "delete it".
 */
import { readConfig, writeConfig } from "../config.ts";
import type { ClientConfig } from "../config.ts";

interface Dimension {
  readonly key: "region" | "network" | "activity";
  readonly label: string;
  readonly what: string;
  readonly stored: string;
}

/**
 * What each flag actually permits, in the developer's terms rather than the schema's.
 *
 * `stored` is separate from `what` on purpose: "an advertiser can target this" and "we keep
 * this" are different questions, and the answers do not line up in the order somebody would
 * guess. Network targeting is the invasive-sounding one and is the only one that persists
 * nothing.
 */
const DIMENSIONS: readonly Dimension[] = [
  {
    key: "region",
    label: "region",
    what: "Advertisers can target the country you are in.",
    stored: "Your country is stored on this install. Not a history — the current value only.",
  },
  {
    key: "network",
    label: "network",
    what: "Advertisers can target IP ranges they supply, and yours is checked against them.",
    stored: "Nothing is stored. Your address is compared during the request and discarded.",
  },
  {
    key: "activity",
    label: "activity",
    what: "Advertisers can target the packages your agent has been reading lately.",
    stored:
      "Nothing new. These are the package ids `obrigado read` already reports, resolved on " +
      "this machine — never a file path, and never your conversation.",
  },
];

/**
 * The one place a developer is told targeting exists.
 *
 * Printed rather than prompted, and that is the deliberate half: `install` runs in scripts and
 * pipes, and a blocking question would hang them. Nothing is turned on here — the offer is
 * made, the command to accept it is given, and the default stays off.
 *
 * The pitch is the indirect one because it is the only honest one. §3's "you earn nothing from
 * it" is what makes farming impressions pointless, so the developer is not paid for this and
 * must not be. What opting in does is make the inventory worth more, and 70% of that lands in
 * their own lockfile.
 */
export function printTargetingOffer(sharing: ClientConfig["sharing"]): void {
  if (sharing?.region === true || sharing?.network === true || sharing?.activity === true) {
    console.log("\nTargeting settings kept from your previous install — `obrigado privacy`.");
    return;
  }

  console.log(
    "\nAdvertisers can currently target this install on one thing: the packages your\n" +
      "project depends on. You can let them target more — your region, an IP range, or\n" +
      "the packages your agent has been reading. All of it is off, and stays off unless\n" +
      "you say otherwise.\n\n" +
      "You would earn nothing for it. Better-targeted inventory sells for more, and 70%\n" +
      "of that goes to the packages in your lockfile — that is the whole of the offer.\n\n" +
      "  obrigado privacy    see what each one means",
  );
}

function usage(): number {
  process.stdout.write(
    "obrigado privacy — what advertisers may target you on\n\n" +
      "  obrigado privacy                 show the current settings\n" +
      "  obrigado privacy <name> on|off   change one\n" +
      "  obrigado privacy all off         turn everything off\n\n" +
      `  names: ${DIMENSIONS.map((d) => d.label).join(", ")}\n`,
  );
  return 1;
}

export async function privacy(argv: readonly string[]): Promise<number> {
  const config = await readConfig();
  if (config === null) {
    process.stdout.write("Not installed. Run `obrigado install` first.\n");
    return 1;
  }

  const [name, value] = argv;
  if (name === undefined) {
    show(config.sharing ?? {});
    return 0;
  }

  if (value !== "on" && value !== "off") return usage();
  const enabled = value === "on";

  if (name === "all") {
    await writeConfig({
      ...config,
      sharing: { region: enabled, network: enabled, activity: enabled },
    });
    process.stdout.write(`Everything is ${value}.\n`);
    return 0;
  }

  const dimension = DIMENSIONS.find((entry) => entry.label === name);
  if (dimension === undefined) return usage();

  await writeConfig({
    ...config,
    sharing: { ...config.sharing, [dimension.key]: enabled },
  });
  process.stdout.write(`${dimension.label} is ${value}. Takes effect on the next render.\n`);
  return 0;
}

function show(sharing: NonNullable<ClientConfig["sharing"]> | Record<string, never>): void {
  process.stdout.write("What advertisers may target you on:\n\n");
  for (const dimension of DIMENSIONS) {
    const on = sharing?.[dimension.key] === true;
    process.stdout.write(`  ${on ? "on " : "off"}  ${dimension.label}\n`);
    process.stdout.write(`       ${dimension.what}\n`);
    process.stdout.write(`       ${dimension.stored}\n\n`);
  }
  process.stdout.write(
    "You earn nothing for any of this, and that is on purpose — being paid for it would\n" +
      "make farming impressions worth doing. Better-targeted inventory sells for more, and\n" +
      "70% of that goes to the packages in your own lockfile.\n\n" +
      "  obrigado privacy <name> on|off\n",
  );
}
