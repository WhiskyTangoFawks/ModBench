import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { errnoCode } from '../ports/errno';
import { leaveWritesUnnamed } from '../repositoriesLib/writeNaming';
import { GIT_DIR, keptUntilNamed, readOrAbsent, stampKept } from './files';

const execFileAsync = promisify(execFile);

// A listing of every file a repository holds outgrows execFile's default buffer.
const OPTIONS = { encoding: 'utf8', maxBuffer: 1 << 28 } as const;

type Git = (folder: string, ...args: string[]) => Promise<string>;
type GitFed = (folder: string, input: string | Buffer, ...args: string[]) => Promise<string>;

const READS = new Set(['status', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'for-each-ref', 'grep', 'show', 'check-ignore', 'check-attr', 'rev-list', 'log', 'diff', 'hash-object']);
const READING_ARGUMENTS = new Set(['--get', '--get-all', '--get-regexp', '--list', 'get-url']);

function subcommandOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') i++;
    else if (!/^-/.test(args[i] ?? '')) return args[i];
  }
  return undefined;
}

// A subcommand not known to only read may write any file of the working tree.
function leaveWritesUnnamedUnlessReading(args: readonly string[]): void {
  const subcommand = subcommandOf(args);
  const reads = subcommand !== undefined && (READS.has(subcommand) || (['config', 'remote'].includes(subcommand) && args.some((arg) => READING_ARGUMENTS.has(arg))));
  if (!reads) leaveWritesUnnamed();
}

function gitWith(env: NodeJS.ProcessEnv | undefined, writesTheWorkingTree: boolean): { git: Git; gitFed: GitFed } {
  const options = env === undefined ? OPTIONS : { ...OPTIONS, env };
  const leaving = (args: readonly string[]): void => { if (writesTheWorkingTree) leaveWritesUnnamedUnlessReading(args); };
  return {
    git: async (folder, ...args) => {
      leaving(args);
      return (await execFileAsync('git', ['-C', folder, ...args], options)).stdout;
    },
    gitFed: async (folder, input, ...args) => {
      leaving(args);
      const running = execFileAsync('git', ['-C', folder, ...args], options);
      // git that exits before it reads its input closes the pipe; its exit says why.
      running.child.stdin?.on('error', () => undefined);
      running.child.stdin?.end(input);
      return (await running).stdout;
    },
  };
}

/** What git answers in `folder`, and what it answers handed `input`. */
export const { git, gitFed } = gitWith(undefined, true);

/** git, staging into the index at `index` and not the repository's. */
export const gitStagingInto = (index: string): { git: Git; gitFed: GitFed } => gitWith({ ...process.env, GIT_INDEX_FILE: index }, false);

/** git, each object it writes kept in `objects` and out of the repository. */
export const gitWritingInto = (objects: string): { git: Git; gitFed: GitFed } => gitWith({ ...process.env, GIT_OBJECT_DIRECTORY: objects }, false);

// A linked worktree and a submodule have the git directory their .git file names.
const gitDirAt = stampKept(async (dotGit: string): Promise<string> => {
  try {
    const linked = (await readFile(dotGit, 'utf8')).split('\n').find((line) => line.startsWith('gitdir:'));
    return linked === undefined ? dotGit : resolve(dirname(dotGit), linked.slice('gitdir:'.length).trim());
  } catch (err) {
    if (errnoCode(err) === 'EISDIR') return dotGit;
    throw err;
  }
});

/** The git directory of the repository at `repository`. */
export const gitDirOf = (repository: string): Promise<string> => readOrAbsent(() => gitDirAt(join(repository, GIT_DIR)), join(repository, GIT_DIR));

// VS Code's git extension runs its reads again at a change at the first level of the git directory, and reads git's
// configuration outside the repository only as part of them (extensions/git/src/repository.ts, DotGitWatcher).
const answersIn = keptUntilNamed(() => Promise.resolve(new Map<string, Promise<string>>()));

/** What git answers in `repository` for a read its git directory's first level and git's configuration decide: kept within
 *  a reading until a change names that first level or the disk is checked, read each time outside one. */
export async function gitKept(repository: string, ...args: string[]): Promise<string> {
  const answers = await answersIn(await gitDirOf(repository));
  const key = [repository, ...args].join('\0');
  const answer = answers.get(key) ?? git(repository, ...args);
  answers.set(key, answer);
  return answer;
}

/** What git answers in `folder`, byte for byte. */
export const gitBytes = async (folder: string, ...args: string[]): Promise<Buffer> =>
  (await execFileAsync('git', ['-C', folder, ...args], { ...OPTIONS, encoding: 'buffer' })).stdout;
