/**
 * What both link commands share: the flags, and the sentence each server error becomes.
 *
 * Split from `link.ts` when `obrigado link github` (A31) arrived, so the email and GitHub paths
 * parse the same listing flags the same way and explain the same failures in the same words.
 */
import type { Socials } from "@obrigado/shared";
import { isSocialPlatform, normalizeHandle, SOCIAL_PLATFORMS } from "@obrigado/shared";

import type { ClientConfig } from "../config.ts";

/** The install a link command speaks for, and where it speaks to. */
export interface LinkFlow {
  readonly config: ClientConfig;
  readonly origin: string;
  readonly options: { readonly apiOrigin: string; readonly installKey: string };
}

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
  github_unavailable: "GitHub linking isn't available right now. Email linking still works.",
  too_many_flows: "Too many GitHub links in progress. Let one finish or expire, then retry.",
  too_many_accounts: "This install already has its maximum number of linked GitHub accounts.",
  flow_invalid: "That GitHub link is no longer in progress. Run `obrigado link github` again.",
};

export function explain(error: string, origin: string): string {
  if (error === "unreachable") return `Could not reach ${origin}.`;
  return ERROR_TEXT[error] ?? `The server refused: ${error}.`;
}

/**
 * `?: T | undefined` rather than `?: T`, because `exactOptionalPropertyTypes` makes those
 * different types: the second says the key may be ABSENT, and the parser always sets every
 * key — to `undefined` when the flag was not given. Absent and undefined mean the same thing
 * to every reader here, so the type says so.
 */
export interface LinkArgs {
  readonly email?: string | undefined;
  readonly code?: string | undefined;
  readonly name?: string | undefined;
  readonly url?: string | undefined;
  readonly socials?: Socials | undefined;
  readonly noList: boolean;
  readonly problem?: string | undefined;
}

/** Tiny by-hand parse, same trade as `cli.ts`: a parser dependency for a handful of flags
 *  would be more surface than the flags. The platform flags come from the shared table, and
 *  a handle is checked here as well as on the server so a typo is a sentence, not a 400. */
export function parseLinkArgs(argv: readonly string[]): LinkArgs {
  let email: string | undefined;
  let code: string | undefined;
  let name: string | undefined;
  let url: string | undefined;
  const socials: Socials = {};
  let noList = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const platform = arg.startsWith("--") ? arg.slice(2) : "";
    if (arg === "--no-list") {
      noList = true;
    } else if (arg === "--code" || arg === "--name" || arg === "--url") {
      const value = argv[i + 1];
      if (value === undefined) return { noList, problem: `${arg} needs a value` };
      if (arg === "--code") code = value;
      if (arg === "--name") name = value;
      if (arg === "--url") url = value;
      i += 1;
    } else if (isSocialPlatform(platform)) {
      const value = argv[i + 1];
      const { label } = SOCIAL_PLATFORMS[platform];
      if (value === undefined) return { noList, problem: `${arg} needs a value` };
      // One account per platform: the second flag is a mistake, not a replacement.
      if (socials[platform] !== undefined) {
        return { noList, problem: `${arg} given twice — one ${label} account per email` };
      }
      const handle = normalizeHandle(platform, value);
      if (handle === null) {
        return { noList, problem: `${JSON.stringify(value)} is not a valid ${label} handle` };
      }
      socials[platform] = handle;
      i += 1;
    } else if (arg.startsWith("--")) {
      return { noList, problem: `unknown flag ${arg}` };
    } else if (email === undefined) {
      email = arg;
    } else {
      return { noList, problem: "more than one email given" };
    }
  }

  return { email, code, name, url, socials, noList };
}
