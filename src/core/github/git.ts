// Cloning a repository and pushing the fix branch. The GitHub token is passed to git through
// environment variables only: it is never written to .git/config or shown in the process list.
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { execa } from "execa";
import { onInterrupt } from "../cleanup.ts";

export interface Clone {
  dir: string;
  headSha: string; // the default branch commit the fix is based on
  cleanup(): Promise<void>;
}

export class UnsafeBranchError extends Error {
  override name = "UnsafeBranchError";
}

const PROTECTED = new Set(["main", "master", "develop", "production", "release", "trunk"]);

/**
 * YakBarber only ever pushes to its own `yakbarber/...` branches, never to the default branch
 * (SPEC 8: never push to a default branch, never merge). Called right before every push.
 */
export function assertSafeBranch(branch: string, defaultBranch: string): void {
  if (branch === defaultBranch) throw new UnsafeBranchError(`Refusing to push to the default branch "${defaultBranch}".`);
  if (PROTECTED.has(branch)) throw new UnsafeBranchError(`Refusing to push to protected branch "${branch}".`);
  if (!/^yakbarber\/[A-Za-z0-9._-]+$/.test(branch)) throw new UnsafeBranchError(`YakBarber only pushes to yakbarber/... branches, not "${branch}".`);
}

/** git config passed via the environment (git ≥ 2.31), so the token stays out of argv and files. */
export function gitEnv(token?: string): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    Object.assign(env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    });
  }
  return env;
}

/**
 * Git LFS stays off: large files arrive as their small pointer files (a fix never needs them), and a machine whose
 * git settings require the git-lfs program still works when it isn't installed (livekit/agents failed to clone, Oct 4).
 */
export const NO_LFS = ["-c", "filter.lfs.process=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.clean=", "-c", "filter.lfs.required=false"];

export function githubCloneUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Shallow-clones the default branch (or `branch`: YakBarber's own pull request branch, for a revision) into a temp
 * folder. Hardened for untrusted repositories: symlinks are checked out as plain files, only https (or file:// in tests)
 * is allowed, no submodules, and the repository's hooks never run. `url` may be a local file:// URL in tests.
 */
export async function cloneRepo(url: string, options: { token?: string; branch?: string } = {}): Promise<Clone> {
  if (options.branch !== undefined && !/^[A-Za-z0-9._][A-Za-z0-9._\/-]*$/.test(options.branch)) throw new Error(`Not a branch name YakBarber clones: ${options.branch}`);
  const parent = await mkdtemp(join(tmpdir(), "yakbarber-clone-"));
  const dir = join(parent, "repo");
  const remove = () => rm(parent, { recursive: true, force: true });
  const unregister = onInterrupt(remove);
  const cleanup = async () => {
    unregister();
    await remove();
  };
  const safety = [
    "-c", "core.symlinks=false",
    "-c", "core.hooksPath=/dev/null",
    ...fetchSafety(url),
    ...NO_LFS,
  ];
  try {
    const which = options.branch ? ["--branch", options.branch, "--single-branch"] : [];
    await execa("git", [...safety, "clone", "--quiet", "--depth", "1", "--no-tags", "--no-recurse-submodules", ...which, url, dir], { env: gitEnv(options.token) });
    const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: dir });
    return { dir, headSha: stdout.trim(), cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export interface FileChange {
  status: "A" | "M" | "D";
  file: string; // relative path, forward slashes
}

/**
 * Copies the changed files from the workspace onto the default branch, commits them as YakBarber,
 * and force-pushes the result to the apifix branch (only ever that branch, see assertSafeBranch).
 * Files are copied byte for byte rather than replayed as a patch, so line endings, .gitattributes
 * and .gitignore rules in the repository can't make the step fail or drop an edit.
 */
export interface CommitAuthor {
  name: string;
  email: string;
}
const DEFAULT_AUTHOR: CommitAuthor = { name: "YakBarber", email: "bot@yakbarber.com" };
// Earlier YakBarber commits may carry an older address; they are still YakBarber's own.
const OWN_EMAILS = new Set([DEFAULT_AUTHOR.email, "bot@yakbarber.dev"]);

/** A commit by YakBarber: its usual address, an older one, or the author it commits as now (the app's bot user). */
export function isOwnCommitEmail(email: string, author?: CommitAuthor): boolean {
  const e = email.trim().toLowerCase();
  return OWN_EMAILS.has(e) || (!!author && e === author.email.toLowerCase());
}

/** Someone else committed to YakBarber's branch: a re-run must not force-push over their work. */
export class BranchChangedError extends Error {
  readonly branch: string;
  readonly by: string;
  constructor(branch: string, by: string) {
    super(`Someone else (${by}) added commits to ${branch}; YakBarber won't overwrite them.`);
    this.branch = branch;
    this.by = by;
  }
}

export async function pushFixBranch(options: {
  clone: Clone;
  changes: FileChange[];
  sourceDir: string; // the workspace folder holding the fixed files
  branch: string;
  defaultBranch: string;
  message: string;
  token?: string;
  remote?: string; // where to push (default: the repository that was cloned); outreach pushes to a fork
  force?: boolean; // replace an existing branch (default true); outreach never overwrites
  author?: CommitAuthor; // who the commit is from (the GitHub App's bot user, so it shows the app's name and logo)
}): Promise<string> {
  const { clone, changes, sourceDir, branch, defaultBranch, message, token, remote = "origin", force = true, author = DEFAULT_AUTHOR } = options;
  assertSafeBranch(branch, defaultBranch);
  if (changes.length === 0) throw new Error("There are no changes to push.");
  if (/[\r\n<>]/.test(author.name + author.email)) throw new Error("Invalid commit author.");
  const git = (args: string[], input?: string) =>
    execa("git", ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...NO_LFS, ...args], {
      cwd: clone.dir,
      env: gitEnv(token),
      input,
    });

  if (force) {
    // Only ever replace a branch whose latest commit is YakBarber's own (tracker C-H3): if the owner pushed a commit or
    // merged their main branch into it, stop and leave their work alone.
    const { stdout: exists } = await git(["ls-remote", remote, `refs/heads/${branch}`]);
    if (exists.trim()) {
      await git(["fetch", "--quiet", "--depth=1", remote, `refs/heads/${branch}`]);
      const { stdout: tipAuthor } = await git(["log", "-1", "--format=%ae", "FETCH_HEAD"]);
      const by = tipAuthor.trim().toLowerCase();
      if (!isOwnCommitEmail(by, author)) throw new BranchChangedError(branch, by);
    }
  }
  await git(["checkout", "--quiet", "-B", branch]);
  const sha = await commitChanges(git, clone.dir, changes, sourceDir, message);

  assertSafeBranch(branch, defaultBranch); // checked again right at the push
  await git(["push", "--quiet", ...(force ? ["--force"] : []), remote, `HEAD:refs/heads/${branch}`]);
  return sha;
}

type Git = (args: string[], input?: string) => Promise<{ stdout: string }>;

/** Copies the changed files from the workspace into the clone, byte for byte, and commits them. Returns the commit. */
async function commitChanges(git: Git, cloneDir: string, changes: FileChange[], sourceDir: string, message: string): Promise<string> {
  for (const { status, file } of changes) {
    if (!isSafeRelativePath(file)) throw new Error(`Refusing to write outside the repository: ${file}`);
    const target = join(cloneDir, file);
    if (status === "D") {
      await rm(target, { force: true });
    } else {
      await mkdir(dirname(target), { recursive: true });
      await cp(join(sourceDir, file), target);
    }
  }
  await git(["add", "-A", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], changes.map((c) => c.file).join("\0"));
  await git(["commit", "--quiet", "-m", message]);
  return (await git(["rev-parse", "HEAD"])).stdout.trim();
}

/**
 * A follow-up commit on YakBarber's pull request branch (revise mode): `clone` is a clone of that branch, the commit goes
 * on top of its tip, and the push is a plain one, never forced. So nothing on the branch is ever replaced, and if anyone
 * pushed to it since it was cloned, GitHub refuses the push and YakBarber stops (BranchChangedError). Only ever a
 * yakbarber/... branch that isn't the default branch, checked before any work and again right at the push.
 */
export async function pushFollowUpCommit(options: {
  clone: Clone; // cloned with cloneRepo(url, { branch })
  changes: FileChange[];
  sourceDir: string;
  branch: string;
  defaultBranch: string;
  message: string;
  token?: string;
  author?: CommitAuthor;
}): Promise<string> {
  const { clone, changes, sourceDir, branch, defaultBranch, message, token, author = DEFAULT_AUTHOR } = options;
  assertSafeBranch(branch, defaultBranch);
  if (changes.length === 0) throw new Error("There are no changes to push.");
  if (/[\r\n<>]/.test(author.name + author.email)) throw new Error("Invalid commit author.");
  const git = (args: string[], input?: string) =>
    execa("git", ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...NO_LFS, ...args], {
      cwd: clone.dir,
      env: gitEnv(token),
      input,
    });
  const { stdout: current } = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current.trim() !== branch) throw new Error(`The copy is on ${current.trim()}, not on ${branch}.`);
  const sha = await commitChanges(git, clone.dir, changes, sourceDir, message);

  assertSafeBranch(branch, defaultBranch); // checked again right at the push
  const pushed = await execa("git", ["-c", "core.hooksPath=/dev/null", ...NO_LFS, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { cwd: clone.dir, env: gitEnv(token), reject: false });
  if (pushed.exitCode !== 0) {
    if (/non-fast-forward|fetch first|rejected|stale info/i.test(String(pushed.stderr))) throw new BranchChangedError(branch, "someone else (the branch moved while YakBarber worked)");
    throw new Error(`git push failed: ${String(pushed.stderr).split("\n")[0]!.slice(0, 200)}`);
  }
  return sha;
}

/**
 * Re-signs the commits of a pull request's yakbarber/... branch with another author (the founder's GitHub identity, so a
 * contributor agreement can be signed for them, Oct 4): same code, same messages, same dates. Only YakBarber's own commits
 * (or ones already signed by `author`) are rewritten; anyone else's commit stops it. The push fails if the branch moved
 * since `expectedTip` was read. `count` is the number of commits on the branch (the pull request's commits).
 */
export async function resignBranch(options: {
  remote: string; // the fork's URL (file:// in tests)
  branch: string;
  defaultBranch: string;
  expectedTip: string;
  count: number;
  author: CommitAuthor;
  token?: string;
}): Promise<{ newTip: string; resigned: number }> {
  const { remote, branch, defaultBranch, expectedTip, count, author, token } = options;
  assertSafeBranch(branch, defaultBranch);
  if (/[\r\n<>]/.test(author.name + author.email)) throw new Error("Invalid commit author.");
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error(`Unexpected number of commits: ${count}.`);
  const parent = await mkdtemp(join(tmpdir(), "yakbarber-resign-"));
  const unregister = onInterrupt(() => rm(parent, { recursive: true, force: true }));
  const git = (args: string[], extra: { env?: Record<string, string>; input?: string; exact?: boolean } = {}) =>
    execa("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...fetchSafety(remote), ...args], {
      cwd: parent,
      env: { ...gitEnv(token), ...extra.env },
      input: extra.input,
      stripFinalNewline: !extra.exact,
    });
  try {
    await git(["init", "--quiet", "--bare"]);
    await git(["fetch", "--quiet", `--depth=${count + 1}`, remote, `refs/heads/${branch}`]);
    const tip = (await git(["rev-parse", "FETCH_HEAD"])).stdout.trim();
    if (tip !== expectedTip) throw new Error(`${branch} moved since it was read (${expectedTip.slice(0, 7)} → ${tip.slice(0, 7)}); run again.`);
    const shas = (await git(["rev-list", "--reverse", `--max-count=${count}`, tip])).stdout.split("\n").filter(Boolean);
    if (shas.length !== count) throw new Error(`Expected ${count} commits on ${branch}, found ${shas.length}.`);

    let base = (await git(["rev-parse", `${shas[0]}^`])).stdout.trim();
    let resigned = 0;
    for (const sha of shas) {
      const [email = "", date = "", parents = ""] = (await git(["log", "-1", "--format=%ae%n%aI%n%P", sha])).stdout.split("\n");
      const by = email.toLowerCase();
      if (!OWN_EMAILS.has(by) && by !== author.email.toLowerCase()) throw new BranchChangedError(branch, by);
      if (parents.trim().includes(" ")) throw new Error(`${branch} has a merge commit; it is not re-signed.`);
      if (OWN_EMAILS.has(by)) resigned++;
      const raw = (await git(["cat-file", "commit", sha], { exact: true })).stdout;
      const message = raw.slice(raw.indexOf("\n\n") + 2);
      const tree = (await git(["rev-parse", `${sha}^{tree}`])).stdout.trim();
      const env = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
      base = (await git(["commit-tree", tree, "-p", base], { env, input: message })).stdout.trim();
    }
    if (resigned === 0) return { newTip: tip, resigned: 0 };
    const [newTree, oldTree] = await Promise.all([git(["rev-parse", `${base}^{tree}`]), git(["rev-parse", `${tip}^{tree}`])]);
    if (newTree.stdout.trim() !== oldTree.stdout.trim()) throw new Error("The re-signed branch would change the code; nothing was pushed.");

    assertSafeBranch(branch, defaultBranch); // checked again right at the push
    await git(["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${tip}`, remote, `${base}:refs/heads/${branch}`]);
    return { newTip: base, resigned };
  } finally {
    unregister();
    await rm(parent, { recursive: true, force: true });
  }
}

/** Only https (or file:// in tests) for fetches and pushes. */
function fetchSafety(url: string): string[] {
  return ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", `protocol.file.allow=${url.startsWith("file://") ? "always" : "never"}`];
}

function isSafeRelativePath(file: string): boolean {
  if (!file || isAbsolute(file) || file.startsWith("~")) return false;
  const segments = file.split(/[\\/]/);
  return !segments.some((s) => s === ".." || s.toLowerCase() === ".git");
}
