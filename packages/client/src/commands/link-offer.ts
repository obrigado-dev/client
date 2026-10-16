/**
 * The wall, offered once at the end of `obrigado install` (A31).
 *
 * People installed and never linked: getting listed was a command they had to come back for, and
 * few did. The end of setup is the one moment they are at a terminal and already answering
 * questions, so it is asked there. An explicit `y` runs `obrigado link github`; anything else is a
 * no and says how to do it later.
 *
 * Never without a terminal and never on a bare newline, for the reasons `privacy-prompt.ts` gives,
 * and once per install: a reinstall that asked again would teach people to press enter through it.
 * The server's own sentence about what is published is still printed before anything is approved
 * (`linkGitHub`), so the question here is the invitation and that sentence is the terms.
 */
import { createInterface } from "node:readline/promises";

import { readConfig, writeConfig } from "../config.ts";
import type { ClientConfig } from "../config.ts";
import { installedTargets } from "./install.ts";
import { linkGitHub } from "./link-github.ts";
import { canAsk, parseAnswer } from "./privacy-prompt.ts";
import type { Ask, Say } from "./privacy-prompt.ts";
import { apiOrigin } from "./shared.ts";

export const LINK_QUESTION =
  "Get thanked by name? obrigado.dev/obrigado lists the people running Obrigado each month.\n" +
  "Link your GitHub to be on it, with your avatar and profile? [y/N] ";

/** What an install that could not ask, or was told no, is left with. */
export const LINK_LATER = "Link your GitHub any time to be listed: obrigado link github";

/** Whether to ask, only mention it, or say nothing. */
export type LinkOffer = "ask" | "mention" | "none";

/**
 * Nothing for an install with no host configured, which has nothing to be thanked for yet, one
 * signed in with GitHub already, or one asked before, whatever it said. Without a terminal the
 * question becomes a line, since a script or an agent can pass it on.
 */
export function linkOffer(config: ClientConfig, canPrompt: boolean): LinkOffer {
  if (installedTargets(config).length === 0) return "none";
  if (config.developer_session !== undefined || config.link_offered_at !== undefined) {
    return "none";
  }
  return canPrompt ? "ask" : "mention";
}

/**
 * One question against the real terminal. Ctrl-C closes the interface, which reads as no answer
 * rather than killing the process before the offer is recorded.
 */
async function askOnTerminal(question: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new AbortController();
  rl.on("close", () => closed.abort());
  rl.on("SIGINT", () => rl.close());
  try {
    return await rl.question(question, { signal: closed.signal });
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

/** How the offer reaches GitHub. The real link in the CLI; a recorder in the tests. */
export type RunLink = (config: ClientConfig) => Promise<number>;

const linkWithGitHub: RunLink = async (config) => {
  const origin = apiOrigin(config);
  const options = { apiOrigin: origin, installKey: config.install_key };
  return await linkGitHub({ config, origin, options }, { noList: false });
};

/**
 * Offer the link, and run it on a yes.
 *
 * Whatever happens the install has already succeeded, so a link that fails or is cancelled is
 * reported by `linkGitHub` and never changes the install's exit code.
 */
export async function offerGitHubLink(
  argv: readonly string[],
  {
    prompt = canAsk(argv),
    ask = askOnTerminal,
    say = console.log,
    run = linkWithGitHub,
  }: {
    /** Whether a person can answer; the terminal decides, a test says. */
    readonly prompt?: boolean;
    readonly ask?: Ask;
    readonly say?: Say;
    readonly run?: RunLink;
  } = {},
): Promise<void> {
  const config = await readConfig();
  if (config === null) return;
  const offer = linkOffer(config, prompt);
  if (offer === "none") return;
  if (offer === "mention") {
    say(LINK_LATER);
    return;
  }

  say("");
  const yes = parseAnswer(await ask(LINK_QUESTION)) === true;
  await writeConfig({
    ...((await readConfig()) ?? config),
    link_offered_at: new Date().toISOString(),
  });
  if (!yes) {
    say(LINK_LATER);
    return;
  }
  say("Ctrl-C skips it; obrigado link github links later.");
  await run(config);
}
