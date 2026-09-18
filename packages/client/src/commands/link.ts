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
import { explain, parseLinkArgs } from "./link-args.ts";
import type { LinkArgs, LinkFlow } from "./link-args.ts";
import { gitHubStatusLines, linkGitHub, unlinkGitHubCommand } from "./link-github.ts";
import { apiOrigin } from "./shared.ts";
import type { LinkedEmailWire } from "@obrigado/shared";
import { LinkCode, LinkEmail, SOCIAL_PLATFORM_IDS } from "@obrigado/shared";

/** One flag per platform, generated from the table the server validates against, wrapped. */
function platformFlags(): string {
  const lines: string[] = [];
  let line = "";
  for (const flag of SOCIAL_PLATFORM_IDS.map((platform) => `--${platform}`)) {
    if (line !== "" && line.length + flag.length + 1 > 72) {
      lines.push(line);
      line = "";
    }
    line = line === "" ? flag : `${line} ${flag}`;
  }
  if (line !== "") lines.push(line);
  return lines.map((text) => `  ${text}`).join("\n");
}

const LINK_USAGE = `obrigado link — put your name (or your company's domain) on obrigado.dev/obrigado

  obrigado link                          where each linked email and account stands
  obrigado link github                   sign in with GitHub; your login lists at once
  obrigado link you@company.com          request a verification code
  obrigado link you@gmail.com --name "Ada L"
  obrigado link --code 123456            confirm with the emailed code
  obrigado link you@company.com --no-list  verify without being listed
  obrigado unlink you@company.com        remove the link and the listing
  obrigado unlink github [login]         remove a GitHub account and its listing

Links, on an email or beside a GitHub login:
  --url https://ada.dev                  one website
  --github ada --x ada_l                 one handle per platform, from:
${platformFlags()}

A company-domain email lists the domain and its links as soon as it is verified; a
personal email lists the name and links you give once they have been reviewed. A GitHub
login lists as soon as GitHub confirms it; a name or links beside it wait for review. Listing
lasts only while a linked install sees a sponsored line that month — the page re-earns
itself on the 1st.
`;

function describe(entry: LinkedEmailWire): string {
  if (!entry.verified) return "unverified";
  if (entry.pending_review) return "verified, awaiting review";
  if (!entry.listed) return "verified, not listed";
  return entry.qualified_this_period
    ? "listed, on this month's page"
    : "listed, no view yet this month";
}

type Flow = LinkFlow;

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
    ...(args.socials === undefined || Object.keys(args.socials).length === 0
      ? {}
      : { socials: args.socials }),
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

  const { emails, github } = result.data;
  if (emails.length === 0 && github.length === 0) {
    console.log("  No emails or GitHub accounts linked to this install.\n");
    console.log(LINK_USAGE);
    return 0;
  }

  console.log(`  Linked to this install — period ${result.data.period}\n`);
  const width = Math.max(
    ...emails.map((entry) => entry.email.length),
    ...github.map((entry) => entry.login.length + 1),
  );
  for (const entry of emails) {
    console.log(`  ${entry.email.padEnd(width)}  ${entry.entity_kind}  ${describe(entry)}`);
  }
  const signedIn = flow.config.developer_session?.login;
  for (const line of gitHubStatusLines(github, width, signedIn)) console.log(line);
  return 0;
}

export async function link(argv: readonly string[]): Promise<number> {
  const config = await readConfig();
  if (config === null) {
    console.log("Obrigado is not installed. Run `obrigado install`.");
    return 1;
  }

  const args = parseLinkArgs(argv[0] === "github" ? argv.slice(1) : argv);
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

  if (argv[0] === "github") return await linkGitHub(flow, args);

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

  if (argv[0] === "github") return await unlinkGitHubCommand(config, argv[1]);

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
