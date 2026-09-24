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
 * ## Four settings, not a level
 *
 * They are independent because the concerns are: somebody may be happy to say which country
 * they are in and not what their agent has been reading, or the reverse. A single scale would
 * present that as a hierarchy of trust, and it is not one: `network` stores nothing at all
 * while `region` stores a country, so the "higher" setting holds less data.
 *
 * `packages` is the one that used to be free. Until A28 the lockfile targeted whether the
 * developer liked it or not, on the grounds that it was the product. A baseline nobody agreed
 * to is not a baseline, so it is a flag like the rest and starts off like the rest. The deps
 * still travel on every session: they are what makes an impression worth buying, and the flag only
 * decides whether an advertiser may buy reach against them.
 *
 * ## Turning one off erases
 *
 * The setting travels on every session, so the server sees the change on the next render
 * rather than at some later sync — and it nulls what it had stored rather than merely
 * declining to read it. Saying no is not "stop using this", it is "delete it".
 */
import { readConfig, writeConfig } from "../config.ts";
import type { ClientConfig } from "../config.ts";
import type { SharingSettings } from "@obrigado/shared";

interface Dimension {
  /**
   * Keyed off the wire type rather than a union repeated here, so a fourth targeting field
   * added to the contract fails to build until this table describes it. A dimension the
   * server can act on and the client never names is one nobody consented to.
   */
  readonly key: keyof SharingSettings;
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
export const DIMENSIONS: readonly Dimension[] = [
  {
    key: "packages",
    label: "packages",
    what: "Advertisers target the packages you depend on.",
    stored:
      "Stores nothing new. Your lockfile is already sent, because it is what the payout " +
      "makes an impression worth buying. This decides whether it can also pick the ad.",
  },
  {
    key: "region",
    label: "region",
    what: "Advertisers target your country.",
    stored: "Stores your country. Current value, no history.",
  },
  {
    key: "network",
    label: "network",
    what: "Advertisers match your IP against ranges they supply.",
    stored: "Stores nothing. Checked during the request, then dropped.",
  },
  {
    key: "activity",
    label: "activity",
    what: "Advertisers target packages your agent read recently.",
    stored:
      "Stores nothing new. Package ids `obrigado read` already reports, resolved locally. " +
      "No paths, no conversation.",
  },
];

/**
 * The offer, for the install that cannot be asked.
 *
 * `install` runs in provisioning scripts, Dockerfiles and CI, where a blocking question is a
 * hang rather than a question — so this is what a run with no terminal attached gets, and what
 * `--no-input` forces. A developer at a keyboard gets `runTargetingSetup` instead, which asks
 * the same three things and shows the JSON each answer produces.
 *
 * Nothing is turned on here either way. The offer is made, the command to accept it is given,
 * and the default stays off.
 *
 * The pitch is the indirect one because it is the only honest one. §3's "you earn nothing from
 * it" is what makes farming impressions pointless, so the developer is not paid for this and
 * must not be. What opting in does is make the inventory worth more, and 70% of that lands in
 * their own lockfile.
 */
export function printTargetingOffer(sharing: ClientConfig["sharing"]): void {
  if (sharing?.region === true || sharing?.network === true || sharing?.activity === true) {
    console.log("\nTargeting settings kept from your last install. See `obrigado privacy`.");
    return;
  }

  console.log(
    "\nAdvertisers cannot target this install on anything. Lockfile, region, IP range\n" +
      "and recently-read packages are all off, and stay off unless you say otherwise.\n" +
      "You earn nothing for turning them on; better targeting just raises what the line is worth.\n\n" +
      "  obrigado privacy    see what each one means",
  );
}

/**
 * Hard-wrap to the width every hand-written paragraph in this CLI already uses.
 *
 * The dimension copy is stored as one sentence per field because it belongs to `DIMENSIONS`
 * rather than to a screen, and two screens now print it at two different indents. Wrapping at
 * the point of use keeps one wording and lets each caller decide where it starts, instead of
 * pre-broken strings that are right in one place and ragged in the other.
 */
export function wrapAt(text: string, indent: string, width = 78): string[] {
  const room = Math.max(width - indent.length, 20);
  const lines: string[] = [];
  let line = "";

  for (const word of text.split(" ")) {
    if (line.length > 0 && line.length + 1 + word.length > room) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) lines.push(indent + line);
  return lines;
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
    // Built from the table rather than listed, so a dimension added to `DIMENSIONS` cannot be
    // left out of "all" and quietly stay on after somebody turned everything off.
    await writeConfig({
      ...config,
      sharing: Object.fromEntries(DIMENSIONS.map((entry) => [entry.key, enabled])),
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
    for (const line of wrapAt(dimension.what, "       ")) process.stdout.write(`${line}\n`);
    for (const line of wrapAt(dimension.stored, "       ")) process.stdout.write(`${line}\n`);
    process.stdout.write("\n");
  }
  process.stdout.write(
    "You earn nothing for any of this, on purpose: paying for consent would make\n" +
      "farming impressions worth doing. Better targeting just raises what the line is worth.\n\n" +
      "  obrigado privacy <name> on|off\n",
  );
}
