/**
 * What Codex's footer takes from the machine and not from the thread: the home directory a path is
 * shortened against, the hostname, and the repository the working directory is in.
 *
 * Codex's snapshot carries none of these (`codex-footer.ts`), so they are worked out here from the
 * working directory it does carry and a handful of facts the caller supplies as `FooterMachine`.
 * Nothing in this file touches the disk itself. Each function says which part of Codex 0.171.0
 * it mirrors (`codex-rs` at `rust-v0.171.0`) and how it was checked.
 */

/** Facts about this machine the snapshot does not carry. Passed in so that tests are exact. */
export interface FooterMachine {
  /** The home directory as Codex sees it (`$HOME`, `os.homedir()`), which `~` stands for. */
  readonly home: string;
  /** The kernel's hostname as it is (`os.hostname()`), or null. It is normalised here. */
  readonly hostname: string | null;
  /** A file's text, or null when it is missing, is a directory, or cannot be read. */
  readonly readFile: (path: string) => string | null;
  /** Whether anything is at the path, following links. */
  readonly exists: (path: string) => boolean;
  /**
   * Epoch milliseconds. No item of Codex 0.171.0's footer depends on the time (a rate limit shows
   * what is left, not when it resets), so nothing reads this yet.
   */
  readonly now: number;
  /** `process.platform`. Only `win32` differs: paths are split on `\` as well and joined with it. */
  readonly platform?: string;
}

function isWindows(machine: FooterMachine): boolean {
  return machine.platform === "win32";
}

function separator(machine: FooterMachine): string {
  return isWindows(machine) ? "\\" : "/";
}

/** A path's components as Rust's `Path::components` gives them for an absolute path. */
function components(path: string, machine: FooterMachine): string[] {
  return path
    .split(isWindows(machine) ? /[\\/]+/u : /\/+/u)
    .filter((part) => part !== "" && part !== ".");
}

function isAbsolute(path: string, machine: FooterMachine): boolean {
  return isWindows(machine)
    ? /^[A-Za-z]:[\\/]/u.test(path) || /^[\\/]{2}/u.test(path)
    : path.startsWith("/");
}

/**
 * A directory with the home directory written `~`: `format_directory_display` in
 * `tui/src/status/helpers.rs`, which the footer calls without a width, so nothing is shortened.
 * A directory that only begins with the same letters as home (`/Users/ann2` beside `/Users/ann`)
 * is not inside it. Checked against Codex 0.171.0 on macOS; the Windows branch follows the source
 * only.
 */
export function directoryDisplay(directory: string, machine: FooterMachine): string {
  if (!isAbsolute(directory, machine) || !isAbsolute(machine.home, machine)) return directory;
  const home = components(machine.home, machine);
  const parts = components(directory, machine);
  if (parts.length < home.length) return directory;
  if (home.some((part, index) => parts[index] !== part)) return directory;
  const rest = parts.slice(home.length);
  return rest.length === 0 ? "~" : `~${separator(machine)}${rest.join(separator(machine))}`;
}

/** The directory above, or null at the top. */
function parentDirectory(path: string, machine: FooterMachine): string | null {
  const windows = isWindows(machine);
  const trailing = windows ? /[\\/]+$/u : /\/+$/u;
  const trimmed = path.replace(trailing, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), windows ? trimmed.lastIndexOf("\\") : -1);
  if (cut < 0) return null;
  const above = trimmed.slice(0, cut).replace(trailing, "");
  if (above === "") return windows ? null : "/";
  return windows && /^[A-Za-z]:$/u.test(above) ? `${above}\\` : above;
}

function join(directory: string, name: string, machine: FooterMachine): string {
  const sep = separator(machine);
  return directory.endsWith(sep) ? `${directory}${name}` : `${directory}${sep}${name}`;
}

/** `os_host_name` in `config/src/host_name.rs`: trimmed, no trailing dot, ASCII lower case. */
export function hostName(machine: FooterMachine): string | null {
  if (machine.hostname === null) return null;
  const name = machine.hostname
    .trim()
    .replace(/\.+$/u, "")
    .replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());
  return name === "" ? null : name;
}

/** The repository a directory is in: where its `.git` is, and the git directory that names. */
export interface Repository {
  readonly root: string;
  /** Null when `.git` is a file that does not point at a git directory, where git itself fails. */
  readonly gitDirectory: string | null;
}

/** A walk upward is bounded so that a path of garbage cannot spin. */
const MAX_ANCESTORS = 128;

/**
 * The nearest directory at or above `start` with a `.git` in it.
 *
 * The rule is `find_ancestor_git_entry` in `git-utils/src/info.rs`, which the project name is
 * taken from: a `.git` that is a file counts, and a `.git` directory counts when it has a `HEAD`.
 * A file is a linked worktree's or a submodule's, and its `gitdir:` line names the git directory,
 * relative to the file's own directory unless absolute.
 */
export function findRepository(start: string, machine: FooterMachine): Repository | null {
  if (!isAbsolute(start, machine)) return null;
  let directory: string | null = start;
  for (let step = 0; directory !== null && step < MAX_ANCESTORS; step += 1) {
    const dotGit = join(directory, ".git", machine);
    if (machine.exists(join(dotGit, "HEAD", machine))) {
      return { root: directory, gitDirectory: dotGit };
    }
    const pointer = machine.readFile(dotGit);
    if (pointer !== null) {
      const named = /^gitdir: (.+?)[\r\n]*$/u.exec(pointer)?.[1];
      if (named === undefined) return { root: directory, gitDirectory: null };
      return {
        root: directory,
        gitDirectory: isAbsolute(named, machine) ? named : join(directory, named, machine),
      };
    }
    directory = parentDirectory(directory, machine);
  }
  return null;
}

/**
 * The name of the directory a repository is in, which is the footer's project name:
 * `status_line_project_root_name_for_cwd` in `chatwidget/status_surfaces.rs`. Checked against
 * Codex 0.171.0 in a repository, a subdirectory of one, a linked worktree and outside any.
 */
export function repositoryName(found: Repository, machine: FooterMachine): string {
  return components(found.root, machine).at(-1) ?? directoryDisplay(found.root, machine);
}

/** A symbolic ref's target, or null when the file's text is anything else (a commit, nothing). */
function symbolicRef(contents: string | null): string | null {
  return contents === null ? null : (/^ref:\s*(\S+)/u.exec(contents)?.[1] ?? null);
}

/** A ref a branch can be, and a path that stays inside the git directory when read as a file. */
function isBranchRef(ref: string): boolean {
  return ref.startsWith("refs/heads/") && ref.length > "refs/heads/".length && !ref.includes("..");
}

/** Git follows a chain of symbolic refs this far and no further (`SYMREF_MAXDEPTH`). */
const MAX_SYMBOLIC_REFS = 5;

/** The directory every worktree of a repository shares, where its branches are kept. */
function commonDirectory(gitDirectory: string, machine: FooterMachine): string {
  const shared = machine.readFile(join(gitDirectory, "commondir", machine))?.trim();
  if (shared === undefined || shared === "") return gitDirectory;
  return isAbsolute(shared, machine) ? shared : join(gitDirectory, shared, machine);
}

/**
 * The checked-out branch, as `git branch --show-current` prints it, which is what Codex runs
 * (`current_branch_name` in `tui/src/branch_summary.rs`): the name after `refs/heads/` when `HEAD`
 * is a symbolic ref into it, and nothing for a detached `HEAD` or when git would fail. A branch
 * not yet born has a name all the same. Checked against Codex 0.171.0 for a repository, a linked
 * worktree, a detached `HEAD`, an unborn branch and no repository.
 *
 * Read from the files, with no git run. `HEAD` is the worktree's own; a branch that is itself a
 * symbolic ref (`main` kept as a name for `master`) is followed as git follows it, and only a
 * loose ref can be one, in the directory all worktrees share. A repository in the reftable format
 * keeps a placeholder in `HEAD` and the truth elsewhere, so it reports no branch.
 *
 * Inferred: Codex looks the branch up when a turn ends or the directory changes and keeps the
 * answer in between, so after a checkout in another terminal it can show the old branch for a
 * while where this shows the new one.
 */
export function currentBranch(found: Repository, machine: FooterMachine): string | null {
  const { gitDirectory } = found;
  if (gitDirectory === null) return null;
  let ref = symbolicRef(machine.readFile(join(gitDirectory, "HEAD", machine)));
  if (ref === null) return null;

  const common = commonDirectory(gitDirectory, machine);
  for (let depth = 0; depth < MAX_SYMBOLIC_REFS && isBranchRef(ref); depth += 1) {
    const next = symbolicRef(machine.readFile(join(common, ref, machine)));
    if (next === null) break;
    ref = next;
  }

  if (!isBranchRef(ref)) return null;
  const name = ref.slice("refs/heads/".length);
  return name === ".invalid" ? null : name;
}
