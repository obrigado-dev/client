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
 */
import type { DeveloperSessionWire, LinkedGitHubWire } from "@obrigado/shared";

import { emailLinkStatus } from "../api.ts";
import { readConfig, writeConfig } from "../config.ts";
import type { ClientConfig } from "../config.ts";
import { pollGitHubLink, startGitHubLink, unlinkGitHub } from "../github-link-api.ts";
import { explain } from "./link-args.ts";
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

  const started = await startGitHubLink(flow.options, {
    consent_listing: !args.noList,
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
  // The server's sentence, verbatim — the one promise the CLI must not paraphrase.
  console.log(args.noList ? "  --no-list: nothing is published.\n" : `  ${data.publishes}\n`);
  console.log(
    `  Enter ${data.user_code} at ${data.verification_uri} ` +
      `(expires in ${Math.round(data.expires_in_s / 60)} min). Waiting…`,
  );
  return await waitForApproval(flow, data.flow, data.interval_s, dependencies);
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
