/**
 * `obrigado link` / `obrigado unlink` — the wall's identity path.
 *
 * The ONE place the developer side of Obrigado ever touches an identity, so the
 * rules are strict: nothing is sent until the developer types an address, the
 * server's own `publishes` sentence is printed before a code is ever entered
 * (the CLI never paraphrases what will be published), and consent to listing is
 * a flag the developer controls, not a default buried in a prompt.
 *
 * Like every command in this directory, it degrades to a sentence offline —
 * a verification flow that prints a stack trace on a train is not one.
 */
import { confirmEmailLink, emailLinkStatus, requestEmailLink, unlinkEmail } from "../api.ts";
import { readConfig, writeConfig } from "../config.ts";
import type { ClientConfig } from "../config.ts";
import { apiOrigin } from "./shared.ts";
import type { LinkedEmailWire } from "@obrigado/shared";
import { LinkCode, LinkEmail } from "@obrigado/shared";

const LINK_USAGE = `obrigado link — put your name (or your company's domain) on obrigado.dev/obrigado

  obrigado link                          where each linked email stands this month
  obrigado link you@company.com          request a verification code
  obrigado link you@gmail.com --name "Ada L" [--url https://ada.dev]
  obrigado link --code 123456            confirm with the emailed code
  obrigado link you@company.com --no-list  verify without being listed
  obrigado unlink you@company.com        remove the link and the listing

A company-domain email lists the domain itself; a personal email lists the name
you give (reviewed before it appears). Listing lasts only while a linked install
sees a sponsored line that month — the page re-earns itself on the 1st.
`;

/**
 * Server error codes → sentences. Each failure has a different next step, which
 * is the whole reason the api layer reports codes instead of `null`.
 */
const ERROR_TEXT: Record<string, string> = {
  feature_disabled: "This server doesn't have email linking enabled yet.",
  disposable_domain: "Disposable email domains can't be linked.",
  invalid_request: "The server rejected that request — check the address and try again.",
  too_many_codes: "Too many codes requested for now. Wait an hour and try again.",
  too_many_emails: "This install already has its maximum number of linked emails.",
  code_expired: "That code has expired. Request a new one with `obrigado link <email>`.",
  code_invalid: "That code doesn't match. Check the email and try again.",
  too_many_attempts: "Too many wrong attempts. Request a new code with `obrigado link <email>`.",
  unknown_install: "This install isn't registered yet — render a status line once, then retry.",
  unknown_email: "That email isn't linked to this install.",
  bad_response: "The server answered with something this client doesn't understand.",
};

function explain(error: string, origin: string): string {
  if (error === "unreachable") return `Could not reach ${origin}.`;
  return ERROR_TEXT[error] ?? `The server refused: ${error}.`;
}

interface LinkArgs {
  readonly email?: string;
  readonly code?: string;
  readonly name?: string;
  readonly url?: string;
  readonly noList: boolean;
  readonly problem?: string;
}

/** Tiny by-hand parse, same trade as `cli.ts`: a parser dependency for five flags
 *  would be more surface than the flags. */
function parseArgs(argv: readonly string[]): LinkArgs {
  let email: string | undefined;
  let code: string | undefined;
  let name: string | undefined;
  let url: string | undefined;
  let noList = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--no-list") {
      noList = true;
    } else if (arg === "--code" || arg === "--name" || arg === "--url") {
      const value = argv[i + 1];
      if (value === undefined) return { noList, problem: `${arg} needs a value` };
      if (arg === "--code") code = value;
      if (arg === "--name") name = value;
      if (arg === "--url") url = value;
      i += 1;
    } else if (arg.startsWith("--")) {
      return { noList, problem: `unknown flag ${arg}` };
    } else if (email === undefined) {
      email = arg;
    } else {
      return { noList, problem: "more than one email given" };
    }
  }

  return { email, code, name, url, noList };
}

function describe(entry: LinkedEmailWire): string {
  if (!entry.verified) return "unverified";
  if (entry.pending_review) return "verified, awaiting review";
  if (!entry.listed) return "verified, not listed";
  return entry.qualified_this_period
    ? "listed, on this month's page"
    : "listed, no view yet this month";
}

interface Flow {
  readonly config: ClientConfig;
  readonly origin: string;
  readonly options: { readonly apiOrigin: string; readonly installKey: string };
}

async function confirmFlow(flow: Flow, args: LinkArgs, code: string): Promise<number> {
  if (!LinkCode.safeParse(code).success) {
    console.log("  A code is six digits, e.g. `obrigado link --code 123456`.");
    return 1;
  }
  const email = args.email ?? flow.config.pending_link_email;
  if (email === undefined) {
    console.log("  Which email? `obrigado link --code 123456 you@company.com`");
    return 1;
  }

  const result = await confirmEmailLink(flow.options, email, code);
  if (!result.ok) {
    console.log(`  ${explain(result.error, flow.origin)}`);
    return 1;
  }
  if (!result.data.linked || result.data.entry === undefined) {
    console.log(`  ${explain("code_invalid", flow.origin)}`);
    return 1;
  }

  if (flow.config.pending_link_email !== undefined) {
    const { pending_link_email: _cleared, ...rest } = flow.config;
    await writeConfig(rest);
  }

  const entry = result.data.entry;
  console.log(`  ${email} verified.`);
  console.log(`  Status: ${describe(entry)}.`);
  if (entry.listed || entry.pending_review) {
    // In production one origin serves both tiers, so `${origin}/obrigado` is the
    // page. The replace only matters in dev, where the API (:3000) and the web
    // tier (:4321) are separate ports.
    console.log(`\n  The page: ${flow.origin.replace(/:3000$/u, ":4321")}/obrigado`);
    console.log("  Remove it any time with `obrigado unlink`.");
  }
  return 0;
}

async function requestFlow(flow: Flow, args: LinkArgs, email: string): Promise<number> {
  if (!LinkEmail.safeParse(email).success) {
    console.log(`  ${JSON.stringify(email)} doesn't look like an email address.`);
    return 1;
  }

  const request = {
    email,
    consent_listing: !args.noList,
    ...(args.name === undefined ? {} : { display_name: args.name }),
    ...(args.url === undefined ? {} : { url: args.url }),
  };

  const result = await requestEmailLink(flow.options, request);
  if (!result.ok) {
    console.log(`  ${explain(result.error, flow.origin)}`);
    return 1;
  }

  await writeConfig({ ...flow.config, pending_link_email: email });

  console.log(`  A code is on its way to ${email}.\n`);
  if (request.consent_listing) {
    // The server's own sentence, verbatim — the one promise the CLI must not
    // paraphrase is what gets published.
    console.log(`  If you confirm it: ${result.data.publishes}\n`);
  } else {
    console.log("  --no-list: the email will be verified but never published.\n");
  }
  console.log("  Confirm with: obrigado link --code 123456");
  console.log(`  The code expires in ${Math.round(result.data.expires_in_s / 60)} minutes.`);
  return 0;
}

async function statusFlow(flow: Flow): Promise<number> {
  const result = await emailLinkStatus(flow.options);
  if (!result.ok) {
    console.log(`  ${explain(result.error, flow.origin)}`);
    if (result.error !== "feature_disabled") console.log(`\n${LINK_USAGE}`);
    return 1;
  }

  if (result.data.emails.length === 0) {
    console.log("  No emails linked to this install.\n");
    console.log(LINK_USAGE);
    return 0;
  }

  console.log(`  Linked emails — period ${result.data.period}\n`);
  const width = Math.max(...result.data.emails.map((entry) => entry.email.length));
  for (const entry of result.data.emails) {
    console.log(`  ${entry.email.padEnd(width)}  ${entry.entity_kind}  ${describe(entry)}`);
  }
  return 0;
}

export async function link(argv: readonly string[]): Promise<number> {
  const config = await readConfig();
  if (config === null) {
    console.log("Obrigado is not installed. Run `obrigado install`.");
    return 1;
  }

  const args = parseArgs(argv);
  if (args.problem !== undefined) {
    console.log(`  ${args.problem}\n`);
    console.log(LINK_USAGE);
    return 1;
  }

  const origin = apiOrigin(config);
  const flow: Flow = {
    config,
    origin,
    options: { apiOrigin: origin, installKey: config.install_key },
  };

  if (args.code !== undefined) return await confirmFlow(flow, args, args.code);
  if (args.email !== undefined) return await requestFlow(flow, args, args.email);
  return await statusFlow(flow);
}

export async function unlink(argv: readonly string[]): Promise<number> {
  const config = await readConfig();
  if (config === null) {
    console.log("Obrigado is not installed. Run `obrigado install`.");
    return 1;
  }

  const email = argv[0];
  if (email === undefined || !LinkEmail.safeParse(email).success) {
    console.log("  Which email? `obrigado unlink you@company.com`");
    return 1;
  }

  const origin = apiOrigin(config);
  const result = await unlinkEmail({ apiOrigin: origin, installKey: config.install_key }, email);
  if (!result.ok) {
    console.log(`  ${explain(result.error, origin)}`);
    return 1;
  }

  console.log(
    result.data.unlinked
      ? "  Unlinked. Any listing disappears the next time the page renders."
      : "  That email wasn't linked to this install.",
  );
  return 0;
}
