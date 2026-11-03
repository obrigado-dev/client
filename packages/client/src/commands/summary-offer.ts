/**
 * The monthly summary (A54): an email, on the 1st, of what this person's linked installs
 * contributed the month before. Asked, never assumed: linking an email agreed to being listed
 * and nothing else.
 *
 * Asked after an email link is verified, and by `obrigado link summary`, only of a person at a
 * terminal. The question is the server's (`summary_offer`), shown and sent back verbatim, since
 * it is what the server keeps as the record of the yes. The choice starts on No: nobody gets a
 * recurring email by pressing Enter through a link. `obrigado link summary off` and every email's
 * own link turn it off.
 */
import type { LinkedEmailWire, LinkSummaryRequest, LinkSummaryResponse } from "@obrigado/shared";

import { emailLinkStatus, setLinkSummary } from "../api.ts";
import type { LinkResult, StatsOptions } from "../api.ts";
import { choose } from "./choose.ts";
import type { ChooseIO } from "./choose.ts";
import { explain } from "./link-args.ts";
import type { LinkFlow } from "./link-args.ts";
import { canAsk } from "./privacy-prompt.ts";
import type { Say } from "./privacy-prompt.ts";

type Send = (
  options: StatsOptions,
  request: LinkSummaryRequest,
) => Promise<LinkResult<LinkSummaryResponse>>;

export interface SummaryDeps {
  readonly prompt?: boolean;
  readonly io?: ChooseIO;
  readonly say?: Say;
  readonly send?: Send;
}

const HINT = "  A monthly email of what your installs contributed: `obrigado link summary`.";

/** Ask about one linked address, when the server offers it and it is not on already. */
export async function offerSummary(
  flow: LinkFlow,
  entry: LinkedEmailWire,
  { prompt = canAsk([]), io, say = console.log, send = setLinkSummary }: SummaryDeps = {},
): Promise<void> {
  const asked = entry.summary_offer;
  if (asked === undefined || entry.monthly_summary === true) return;
  if (!prompt) {
    say(HINT);
    return;
  }
  say("");
  const answer = await choose(asked, ["Yes", "No"], 1, io);
  if (answer !== 0) {
    say("  No monthly summary. `obrigado link summary` asks again.");
    return;
  }
  const result = await send(flow.options, { email: entry.email, on: true, asked });
  say(
    result.ok
      ? `  Monthly summary on for ${entry.email}. Every email has a one-click unsubscribe.`
      : `  Couldn't turn it on: ${explain(result.error, flow.origin)}`,
  );
}

const USAGE = "  `obrigado link summary` to be asked, `obrigado link summary off` to stop it.";

/** Off for every linked address that has it on. */
async function turnOff(
  flow: LinkFlow,
  emails: readonly LinkedEmailWire[],
  say: Say,
  send: Send,
): Promise<number> {
  const on = emails.filter((entry) => entry.monthly_summary === true);
  if (on.length === 0) {
    say("  No linked email gets the monthly summary.");
    return 0;
  }
  for (const entry of on) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of addresses, in order
    const result = await send(flow.options, { email: entry.email, on: false });
    say(
      result.ok
        ? `  Monthly summary off for ${entry.email}.`
        : `  Couldn't turn it off for ${entry.email}: ${explain(result.error, flow.origin)}`,
    );
  }
  return 0;
}

/** `obrigado link summary [on|off] [email]`. */
export async function summaryCommand(
  flow: LinkFlow,
  argv: readonly string[],
  deps: SummaryDeps = {},
): Promise<number> {
  const say = deps.say ?? console.log;
  const send = deps.send ?? setLinkSummary;
  const words = argv.filter((word) => word !== "on" && word !== "off");
  const off = argv.includes("off");
  const only = words[0];
  if (words.length > 1 || (only !== undefined && !only.includes("@"))) {
    say(USAGE);
    return 1;
  }

  const status = await emailLinkStatus(flow.options);
  if (!status.ok) {
    say(`  ${explain(status.error, flow.origin)}`);
    return 1;
  }
  const emails = status.data.emails.filter(
    (entry) =>
      entry.verified && (only === undefined || entry.email.toLowerCase() === only.toLowerCase()),
  );
  if (emails.length === 0) {
    say(
      only === undefined
        ? "  The monthly summary goes to an email linked to this install. Link one first:\n" +
            "  `obrigado link you@company.com --no-list` verifies it without listing you."
        : `  ${only} isn't a verified email linked to this install.`,
    );
    return 1;
  }

  if (off) return await turnOff(flow, emails, say, send);

  const offered = emails.filter((entry) => entry.summary_offer !== undefined);
  if (offered.length === 0) {
    say(
      emails.every((entry) => entry.monthly_summary === true)
        ? `  Already on for ${emails.map((entry) => entry.email).join(", ")}. ${USAGE.trim()}`
        : "  This server doesn't send the monthly summary yet.",
    );
    return 0;
  }
  if (!(deps.prompt ?? canAsk([]))) {
    say("  Run `obrigado link summary` in a terminal to be asked.");
    return 1;
  }
  for (const entry of offered) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one question at a time
    await offerSummary(flow, entry, { ...deps, prompt: true, say, send });
  }
  return 0;
}
