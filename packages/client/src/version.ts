/**
 * This client's version, on the wire.
 *
 * This matters the moment the backend deploys separately from the extensions. Without a
 * version on the wire there is no way to ask what is actually installed, to scope an incident
 * to a release, or to know whether a contract change is safe to make. The beacon-queue outage
 * was diagnosable here because there was one machine and its files were readable; across a
 * population it would have looked like revenue quietly falling with nothing to correlate.
 *
 * A literal rather than an import of `package.json`: `rootDir` is `src`, so the manifest is
 * outside the compiled project, and pulling it in means loosening the build to carry one
 * string. Two places to bump is one place to forget — so `version.test.ts` asserts they
 * agree, which buys the same guarantee without the build gymnastics.
 */
export const CLIENT_VERSION = "0.0.0";

/**
 * Which host this client was installed into.
 *
 * A closed set rather than a free string: it is a rollup key on the server, and a typo in it
 * splits one agent's traffic into two populations that no query joins back together.
 *
 * The names now come from `@obrigado/shared/agents`, which is the one table the installer, the
 * session poller and the landing page all derive their own lists from. Kept re-exported here
 * because `Agent` is the name the rest of this package speaks, and because a rollup key
 * belongs conceptually to the client's wire contract even when the data lives elsewhere.
 */
export { AGENT_IDS as AGENTS, isAgentId as isAgent } from "@obrigado/shared/agents";
export type { AgentId as Agent } from "@obrigado/shared/agents";

/**
 * What `obrigado statusline` means with no `--agent`.
 *
 * Not a compatibility shim: every installer writes the flag explicitly, so this
 * is only reached when a developer runs the command by hand to see what it
 * prints. Claude Code is the honest guess there — it is the one host with a
 * status line today.
 */
export const DEFAULT_AGENT = "claude-code" as const;
