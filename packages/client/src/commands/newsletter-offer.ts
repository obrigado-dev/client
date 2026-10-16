/**
 * The newsletter, offered once a GitHub link finishes.
 *
 * Asked only of a person at a terminal, once per install, about the address GitHub verified for
 * the account just linked: the link asks GitHub for it only when this will be asked
 * (`willOfferNewsletter`). The question names the address and, on the line under it, who is asking
 * and that they can unsubscribe, which CASL wants said before anyone answers. The choice starts on
 * Yes, and a yes subscribes; Ctrl-C, Escape or the input ending is a no. The server keeps the
 * question as it was shown, and every email it leads to has a one-click unsubscribe.
 */
import { API_VERSION, NewsletterSubscribeResponseSchema } from "@obrigado/shared";
import type { NewsletterSubscribeResponse } from "@obrigado/shared";

import { STATS_TIMEOUT_MS } from "../api.ts";
import { readConfig, writeConfig } from "../config.ts";
import type { ClientConfig } from "../config.ts";
import { choose } from "./choose.ts";
import type { ChooseIO } from "./choose.ts";
import type { LinkFlow } from "./link-args.ts";
import { canAsk } from "./privacy-prompt.ts";
import type { Say } from "./privacy-prompt.ts";

export const newsletterQuestion = (email: string): string =>
  `Get occasional news and promotional content related to the open source world at ${email}?`;

/** Whether this link will end with the question, and so should ask GitHub for the address. */
export function willOfferNewsletter(config: ClientConfig, prompt = canAsk([])): boolean {
  return prompt && config.newsletter_offered_at === undefined;
}

type Subscribe = (
  flow: LinkFlow,
  offer: { readonly email: string; readonly vouch: string; readonly asked: string },
) => Promise<NewsletterSubscribeResponse | null>;

const subscribe: Subscribe = async (flow, offer) => {
  try {
    const response = await fetch(`${flow.origin}/api/${API_VERSION}/newsletter/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Obrigado-Key": flow.options.installKey },
      body: JSON.stringify(offer),
      signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = NewsletterSubscribeResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Who asks, when a server from before it said so does not: never a question without it. */
const FROM = "From Obrigado (obrigado.dev). Unsubscribe any time.";

/** Ask, on a link that brought back a vouched address. */
export async function offerNewsletter(
  flow: LinkFlow,
  offer: {
    readonly email: string | undefined;
    readonly vouch: string | undefined;
    readonly from?: string | undefined;
  },
  {
    prompt = canAsk([]),
    io,
    say = console.log,
    send = subscribe,
  }: {
    readonly prompt?: boolean;
    readonly io?: ChooseIO;
    readonly say?: Say;
    readonly send?: Subscribe;
  } = {},
): Promise<void> {
  const { email, vouch } = offer;
  if (email === undefined || vouch === undefined) return;
  const config = (await readConfig()) ?? flow.config;
  if (!willOfferNewsletter(config, prompt)) return;

  say("");
  // What was shown is what is kept: the question, and who asked it.
  const asked = `${newsletterQuestion(email)}\n${offer.from ?? FROM}`;
  const answer = await choose(asked, ["Yes", "No"], 0, io);
  await writeConfig({
    ...((await readConfig()) ?? config),
    newsletter_offered_at: new Date().toISOString(),
  });
  if (answer !== 0) return;

  const result = await send(flow, { email, vouch, asked });
  say(
    result === null
      ? "  Couldn't subscribe you just now, and it isn't asked again."
      : result.status === "already_subscribed"
        ? `  ${email} is already subscribed.`
        : `  Subscribed ${email}. Every email has a one-click unsubscribe.`,
  );
}
