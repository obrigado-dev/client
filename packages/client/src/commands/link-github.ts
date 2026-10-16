/**
 * `obrigado link github` and `obrigado unlink github` — the wall's second identity (A31), and how
 * a developer signs in (A33).
 *
 * GitHub's device flow, driven from a terminal. The server starts it; this prints the code and
 * where to type it, then polls until the person approves, cancels, or lets the code expire. The
 * rules `link.ts` keeps hold here as well: the server's own `publishes` sentence is printed before
 * anything is approved, and whether to be listed is a flag, never a default.
 *
 * An approved link also signs this install in: the server hands over a session once, and it is
 * kept in the config until `obrigado unlink github` ends it.
 *
 * The code waits in the config until the link settles, so a later `obrigado link github` finishes
 * it rather than starting another. That is what `--no-wait` is for: a coding agent's shell gives
 * up long before a person has typed a code on github.com, so the agent runs `--no-wait`, hands the
 * person the code, and runs `obrigado link github` once they have approved it.
 */
import type { DeveloperSessionWire, LinkedGitHubWire } from "@obrigado/shared";

import { emailLinkStatus } from "../api.ts";
import { readConfig, writeConfig } from "../config.ts";
import type { ClientConfig } from "../config.ts";
import { pollGitHubLink, startGitHubLink, unlinkGitHub } from "../github-link-api.ts";
import { explain } from "./link-args.ts";
import { offerNewsletter, willOfferNewsletter } from "./newsletter-offer.ts";
import type { LinkArgs, LinkFlow } from "./link-args.ts";
import { apiOrigin } from "./shared.ts";

function describe(entry: LinkedGitHubWire): string {
  if (!entry.verified) return "unverified";
  if (!entry.listed) return "verified, not listed";
  const extras = entry.pending_review ? ", name and links awaiting review" : "";
  return entry.qualified_this_period
    ? `listed${extras}, on this month's page`
    : `listed${extras}, no view yet this month`;
}

/** The GitHub half of `obrigado link`'s status table, padded to the same column. */
export function gitHubStatusLines(
  entries: readonly LinkedGitHubWire[],
  width: number,
  signedIn: string | undefined,
): string[] {
  return entries.map((entry) => {
    const here = sameLogin(entry.login, signedIn) ? " (signed in here)" : "";
    return `  ${`@${entry.login}`.padEnd(width)}  github  ${describe(entry)}${here}`;
  });
}

function sameLogin(login: string, other: string | undefined): boolean {
  return other !== undefined && login.toLowerCase() === other.toLowerCase();
}

type DeveloperSession = NonNullable<ClientConfig["developer_session"]>;
type PendingLink = NonNullable<ClientConfig["pending_github_link"]>;

/** Keep the link waiting for its code, or forget it. Read again first, as `storeSession` does. */
async function keepPending(fallback: ClientConfig, pending: PendingLink | null): Promise<void> {
  const { pending_github_link: _replaced, ...rest } = (await readConfig()) ?? fallback;
  await writeConfig(pending === null ? rest : { ...rest, pending_github_link: pending });
}

/**
 * The link to come back to: one still waiting, asked for the same way. A request with a name or
 * links, or one listing where the waiting one did not, is a different request and starts afresh.
 */
function waitingLink(config: ClientConfig, args: LinkArgs, now = Date.now()): PendingLink | null {
  const pending = config.pending_github_link;
  if (pending === undefined || Date.parse(pending.expires_at) <= now + 5000) return null;
  const different =
    args.name !== undefined ||
    args.url !== undefined ||
    Object.keys(args.socials ?? {}).length > 0 ||
    pending.listed === args.noList;
  return different ? null : pending;
}

/** Where to type the code, and for how long. */
function enterCode(pending: PendingLink, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((Date.parse(pending.expires_at) - now) / 60_000));
  return `Enter ${pending.user_code} at ${pending.verification_uri} (expires in ${minutes} min).`;
}

/**
 * Keep this install's session, or drop it. The config is read again first: a link waits minutes
 * for approval, and anything another command wrote meanwhile must survive.
 */
async function storeSession(
  fallback: ClientConfig,
  session: DeveloperSession | null,
): Promise<void> {
  const { developer_session: _replaced, ...rest } = (await readConfig()) ?? fallback;
  await writeConfig(session === null ? rest : { ...rest, developer_session: session });
}

/** Keep the session an approval handed over, answering the day it ends, or null for none. */
async function signedInAs(
  flow: LinkFlow,
  login: string,
  session: DeveloperSessionWire | undefined,
): Promise<string | null> {
  if (session === undefined) return null;
  await storeSession(flow.config, { token: session.token, login, expires_at: session.expires_at });
  return session.expires_at.slice(0, 10);
}

/** What `link github` refuses before asking the server anything. */
function refusal(args: LinkArgs): string | null {
  if (args.email !== undefined) return "`obrigado link github` takes no email.";
  if (args.code !== undefined)
    return "`--code` confirms an email; GitHub needs no code typed here.";
  if (args.socials?.github !== undefined) {
    return "`--github` is not needed: the account you sign in with is the GitHub link.";
  }
  return null;
}

export interface PollDependencies {
  readonly sleep: (ms: number) => Promise<void>;
}

/** Real time. Tests pass a sleep that returns at once. */
const REAL_TIME: PollDependencies = { sleep: (ms) => Bun.sleep(ms) };

export async function linkGitHub(
  flow: LinkFlow,
  args: LinkArgs,
  dependencies: PollDependencies = REAL_TIME,
): Promise<number> {
  const refused = refusal(args);
  if (refused !== null) {
    console.log(`  ${refused}`);
    return 1;
  }

  // Read now rather than taken from the flow: the link it may finish was kept by an earlier run.
  const waiting = waitingLink((await readConfig()) ?? flow.config, args);
  if (waiting !== null) {
    console.log(`  ${waiting.publishes}\n`);
    console.log(`  Already started. ${enterCode(waiting)}`);
    if (args.noWait === true) {
      console.log("  Then run `obrigado link github` to finish.");
      return 0;
    }
    console.log("  Waiting…");
    return await settle(flow, waiting, dependencies);
  }

  const started = await startGitHubLink(flow.options, {
    consent_listing: !args.noList,
    // GitHub is asked for the address only when the link will end by offering the newsletter.
    ...(args.noWait !== true && willOfferNewsletter(flow.config) ? { newsletter: true } : {}),
    ...(args.name === undefined ? {} : { display_name: args.name }),
    ...(args.url === undefined ? {} : { url: args.url }),
    ...(args.socials === undefined || Object.keys(args.socials).length === 0
      ? {}
      : { socials: args.socials }),
  });
  if (!started.ok) {
    console.log(`  ${explain(started.error, flow.origin)}`);
    return 1;
  }

  const { data } = started;
  const pending: PendingLink = {
    flow: data.flow,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    interval_s: data.interval_s,
    expires_at: new Date(Date.now() + data.expires_in_s * 1000).toISOString(),
    listed: !args.noList,
    // The server's sentence, verbatim — the one promise the CLI must not paraphrase.
    publishes: args.noList ? "--no-list: nothing is published." : data.publishes,
  };
  await keepPending(flow.config, pending);
  console.log(`  ${pending.publishes}\n`);
  if (args.noWait === true) {
    console.log(`  ${enterCode(pending)}`);
    console.log("  Then run `obrigado link github` to finish.");
    return 0;
  }
  console.log(`  ${enterCode(pending)} Waiting…`);
  return await settle(flow, pending, dependencies);
}

/** Wait the link out, then forget it, whatever became of it. A Ctrl-C leaves it to come back to. */
async function settle(
  flow: LinkFlow,
  pending: PendingLink,
  dependencies: PollDependencies,
): Promise<number> {
  try {
    return await waitForApproval(flow, pending.flow, pending.interval_s, dependencies);
  } finally {
    await keepPending(flow.config, null);
  }
}

/**
 * One poll, then another after the interval, until the flow settles.
 *
 * Recursive rather than a loop because each poll genuinely waits on the one before: the interval
 * is GitHub's to lengthen, and it arrives in the previous answer.
 */
async function waitForApproval(
  flow: LinkFlow,
  handle: string,
  intervalS: number,
  dependencies: PollDependencies,
): Promise<number> {
  await dependencies.sleep(intervalS * 1000);
  const polled = await pollGitHubLink(flow.options, handle);
  if (!polled.ok) {
    console.log(`  ${explain(polled.error, flow.origin)}`);
    return 1;
  }
  const outcome = polled.data;
  if (outcome.status === "pending") {
    return await waitForApproval(flow, handle, outcome.interval_s, dependencies);
  }
  if (outcome.status === "linked") {
    console.log(`\n  Linked @${outcome.entry.login}: ${describe(outcome.entry)}.`);
    const until = await signedInAs(flow, outcome.entry.login, outcome.session);
    const signedIn = until === null ? "" : `Signed in until ${until}. `;
    console.log(`  ${signedIn}Undo with \`obrigado unlink github\`.`);
    await offerNewsletter(flow, { email: outcome.email, vouch: outcome.newsletter_vouch });
    return 0;
  }
  console.log(
    outcome.status === "denied"
      ? "\n  Cancelled on GitHub."
      : "\n  The code expired. Run `obrigado link github` again.",
  );
  return 1;
}

/** Which login to unlink: the one named, or the only one there is. */
async function loginToUnlink(
  options: LinkFlow["options"],
  named: string | undefined,
): Promise<{ login: string } | { problem: string }> {
  if (named !== undefined) return { login: named.replace(/^@/u, "") };
  const status = await emailLinkStatus(options);
  if (!status.ok) return { problem: explain(status.error, options.apiOrigin) };
  const [only, ...others] = status.data.github;
  if (only === undefined) return { problem: "No GitHub account is linked to this install." };
  if (others.length > 0) {
    const logins = status.data.github.map((entry) => `@${entry.login}`).join(", ");
    return { problem: `Which account? ${logins} — \`obrigado unlink github <login>\`` };
  }
  return { login: only.login };
}

export async function unlinkGitHubCommand(
  config: ClientConfig,
  named: string | undefined,
): Promise<number> {
  const options = { apiOrigin: apiOrigin(config), installKey: config.install_key };
  const target = await loginToUnlink(options, named);
  if ("problem" in target) {
    console.log(`  ${target.problem}`);
    return 1;
  }

  const result = await unlinkGitHub(options, target.login);
  if (!result.ok) {
    console.log(`  ${explain(result.error, options.apiOrigin)}`);
    return 1;
  }
  // Either way the server holds no session for it now, so neither should this install.
  if (sameLogin(target.login, config.developer_session?.login)) await storeSession(config, null);
  console.log(
    result.data.unlinked
      ? `  @${target.login} unlinked. Any listing disappears the next time the page renders.`
      : `  @${target.login} wasn't linked to this install.`,
  );
  return 0;
}
