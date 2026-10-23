// The instance repository holds this machine's folders and accounts by a token (modlist-repository.md, The repository,
// story 4).

import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { errnoCode } from '../errno';
import { exists, get, isRepository, makeTempDir, putIfChanged, remove, undoAll, type Undo } from '../files';
import { git, gitFed, gitWritingInto } from '../git';
import type { GameFolder, InstanceAdapter } from '../instanceAdapter';
import {
  folderTokens, holdsPathToken, sedLiteral, sedReplacement, sedSubstitution, tokenFilterConfig, type PathSpelling, type TokenProgram,
} from '../pathTokens';
import { PROFILE_INIS_PATTERN, SETTINGS_FILE_PATTERN, settingsFile } from './layout';
import type { ConfigurationFile } from '../publisher';
import type { Mo2Context } from './mo2Context';

type Mo2PathTokens = Pick<InstanceAdapter, 'writePathTokens' | 'pathsOutsideFolders'>;

// MO2 is a Windows program. Qt's INI escapes a backslash, MO2 can write a drive's own separator twice, and a value can
// end at a quote or at @ByteArray's parenthesis.
const SPELLING: PathSpelling = {
  separators: [{ first: '/', rest: '/' }, { first: '\\', rest: '\\' }, { first: '\\\\', rest: '\\\\' }, { first: '\\\\\\\\', rest: '\\\\' }],
  ends: '")',
};

// The [Settings] keys MO2 keeps out of its log as accounts (settings.cpp, Settings::dump), and those it dropped in 2.2.0.
const ACCOUNT_KEYS = ['username', 'password', 'steam_username', 'steam_password', 'nexus_username', 'nexus_password', 'nexus_login', 'nexus_api_key'];
const ACCOUNT_TOKEN = '{account}';

// From the [Settings] header to the next section's.
const IN_SETTINGS = String.raw`/^\[Settings\]/,/^\[/`;

interface CoveredFile {
  /** As git's attributes match it. */
  readonly pattern: string;
  readonly driver: string;
  readonly spelling: PathSpelling;
  readonly holdsAccounts: boolean;
}

// The mod manager's configuration holds the accounts, so its filter is a driver of its own.
const coveredFiles = (publisherFile: ConfigurationFile | undefined): CoveredFile[] => [
  { pattern: SETTINGS_FILE_PATTERN, driver: 'modbench-settings-tokens', spelling: SPELLING, holdsAccounts: true },
  { pattern: PROFILE_INIS_PATTERN, driver: 'modbench-tokens', spelling: SPELLING, holdsAccounts: false },
  ...(publisherFile === undefined ? [] : [
    { pattern: `/${publisherFile.name}`, driver: 'modbench-publisher-tokens', spelling: publisherFile.spelling, holdsAccounts: false },
  ]),
];

// A clone holds no account, so its value is empty.
function accountTokens(settings: string): TokenProgram {
  const valueOf = (key: string): string => {
    const value = new RegExp(`^${key} *= *(.*?)\\r?$`, 'm').exec(settings)?.[1] ?? '';
    return value === ACCOUNT_TOKEN ? '' : value;
  };
  return {
    clean: ACCOUNT_KEYS.map((key) => IN_SETTINGS + sedSubstitution(`^\\(${key} *= *\\)[^[:cntrl:]]*`, `\\1${sedReplacement(ACCOUNT_TOKEN)}`)),
    smudge: ACCOUNT_KEYS.map((key) => IN_SETTINGS + sedSubstitution(`^\\(${key} *= *\\)${sedLiteral(ACCOUNT_TOKEN)}`, `\\1${sedReplacement(valueOf(key))}`)),
  };
}

// The attributes live in the git directory, as the filter's config does, so the repository holds no file of Modbench's.
// Answers the call that takes back the lines it added.
async function attributesWritten(instanceRoot: string, covered: readonly CoveredFile[]): Promise<Undo> {
  const file = resolve(instanceRoot, (await git(instanceRoot, 'rev-parse', '--git-path', 'info/attributes')).trim());
  await mkdir(dirname(file), { recursive: true });
  const lines = covered.map(({ pattern, driver }) => `${pattern} filter=${driver} diff=${driver}`);
  let added: string[] = [];
  await putIfChanged(file, (before) => {
    const held = new Set(before.split(/\r?\n/));
    added = lines.filter((line) => !held.has(line));
    return added.length === 0 ? before : `${before}${before === '' || before.endsWith('\n') ? '' : '\n'}${added.join('\n')}\n`;
  }, { ifMissing: '' });
  return async () => {
    await putIfChanged(file, (text) => text.split('\n').filter((line) => !added.includes(line.replace(/\r$/, ''))).join('\n'));
  };
}

interface HeldFile { readonly file: string; readonly covered: boolean }

// Each file git holds or would commit, and whether the token filter covers it. check-attr -z answers path, attribute,
// value.
async function filesGitHolds(instanceRoot: string, covered: readonly CoveredFile[]): Promise<HeldFile[]> {
  const listed = await git(instanceRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard');
  const answers = (await gitFed(instanceRoot, listed, 'check-attr', '-z', '--stdin', 'filter')).split('\0');
  const files = new Map<string, boolean>();
  for (let at = 0; at + 2 < answers.length; at += 3) {
    const [file, , value] = answers.slice(at, at + 3);
    if (file !== undefined) files.set(file, covered.some(({ driver }) => driver === value));
  }
  return [...files].map(([file, covered]) => ({ file, covered }));
}

// A submodule's path is a folder.
const absentAs = <T>(absent: T) => (err: unknown): T => {
  if (errnoCode(err) !== 'ENOENT' && errnoCode(err) !== 'EISDIR') throw err;
  return absent;
};

const holdsToken = (text: string): boolean => holdsPathToken(text) || text.includes(ACCOUNT_TOKEN);

type ScratchGit = ReturnType<typeof gitWritingInto>;

// The blobs git writes to run its filter on a text are scratch, kept out of the repository.
async function withScratch<T>(use: (scratch: ScratchGit) => Promise<T>): Promise<T> {
  const objects = await makeTempDir(join(tmpdir(), 'modbench-objects-'));
  try {
    return await use(gitWritingInto(objects));
  } finally {
    await remove(objects);
  }
}

// git's own smudge, run on what the working tree holds.
async function checkedOut(scratch: ScratchGit, instanceRoot: string, file: string, text: string): Promise<string> {
  const blob = (await scratch.gitFed(instanceRoot, text, 'hash-object', '-w', '--no-filters', '--stdin')).trim();
  return scratch.git(instanceRoot, 'cat-file', '--filters', `--path=${file}`, blob);
}

// The files that still hold a path token once git has put this machine's values in place of the tokens.
async function smudged(scratch: ScratchGit, instanceRoot: string, files: readonly string[]): Promise<string[]> {
  const holding: string[] = [];
  for (const file of files) {
    await putIfChanged(join(instanceRoot, file), async (text) => {
      const after = holdsToken(text) ? await checkedOut(scratch, instanceRoot, file, text) : text;
      if (holdsPathToken(after)) holding.push(file);
      return after;
    }).catch(absentAs(undefined));
  }
  return holding;
}

// git takes a file whose stat matches its index entry as unchanged, and one whose size differs as changed, unfiltered;
// an entry with no stat goes through the filter. --index-info takes ls-files --stage's lines.
async function statsForgotten(instanceRoot: string, files: readonly string[]): Promise<void> {
  if (files.length === 0) return;
  const staged = (await git(instanceRoot, 'ls-files', '--stage', '-z', '--', ...files)).split('\0').filter((line) => / 0\t/.test(line));
  if (staged.length > 0) await gitFed(instanceRoot, staged.map((line) => `${line}\0`).join(''), 'update-index', '-z', '--index-info');
}

// What a commit would hold of a file the filter covers: git's own clean.
async function heldByGit(scratch: ScratchGit, instanceRoot: string, file: string): Promise<string> {
  if (!(await exists(join(instanceRoot, file)))) return '';
  return scratch.git(instanceRoot, 'cat-file', 'blob', (await scratch.git(instanceRoot, 'hash-object', '-w', '--', file)).trim());
}

// A line of git's own pattern files is a pattern from the repository's root, never a path on this machine.
const GIT_PATTERN_FILES = new Set(['.gitignore', '.gitattributes']);

// A path on a drive, on a network share, or from the root, up to the end of its line or a quote. A Qt escaped quote
// leaves its backslash, and @ByteArray its parenthesis.
const DRIVE_PATH = String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/](?!")[^\r\n"]*`;
const SHARE_PATH = String.raw`(?<=^|[=\s"(,])(?:\\{2}|\\{4}|//)(?=[A-Za-z0-9])[^\r\n"]*`;
const ROOT_PATH = String.raw`(?<=^|[=\s"(,:])/(?![/\s"}])[^\r\n"]*`;
const PATH = new RegExp([DRIVE_PATH, SHARE_PATH, ROOT_PATH].join('|'), 'gm');

const pathsIn = (text: string): string[] => [...text.matchAll(PATH)].map(({ 0: match, index }) => {
  const trimmed = match.trimEnd();
  const quoted = trimmed === match && text[index + match.length] === '"' ? trimmed.replace(/\\$/, '') : trimmed;
  return text[index - 1] === '(' ? quoted.replace(/\)$/, '') : quoted;
});

const filterWritten = (instanceRoot: string, driver: string): Promise<boolean> =>
  git(instanceRoot, 'config', '--get', `filter.${driver}.clean`).then((value) => value.trim() !== '', () => false);

const filesNotWritten = async (instanceRoot: string, covered: readonly CoveredFile[]): Promise<CoveredFile[]> => {
  const written = await Promise.all(covered.map(({ driver }) => filterWritten(instanceRoot, driver)));
  return covered.filter((_file, at) => !written[at]);
};

/** Whether the repository's local config holds the path filter of each file it covers, `publisherFile` among them. */
export const pathTokensWritten = async (instanceRoot: string, publisherFile: ConfigurationFile | undefined): Promise<boolean> =>
  (await filesNotWritten(instanceRoot, coveredFiles(publisherFile))).length === 0;

const foundRoot = (folder: GameFolder): string | undefined => (folder.kind === 'found' ? folder.root : undefined);

export function mo2PathTokens({ instanceRoot }: Mo2Context, gameFolder: () => Promise<GameFolder>, publisherFile: ConfigurationFile | undefined): Mo2PathTokens {
  const covered = coveredFiles(publisherFile);
  const configOf = (files: readonly CoveredFile[], game: string | undefined, accounts: TokenProgram): Readonly<Record<string, string>> =>
    Object.fromEntries(files.flatMap(({ driver, spelling, holdsAccounts }) => {
      const folders = folderTokens({ instance: instanceRoot, game }, process.platform, spelling);
      return Object.entries(tokenFilterConfig(driver, folders, ...(holdsAccounts ? [accounts] : [])));
    }));
  const configWritten = async (game: string | undefined, accounts: TokenProgram): Promise<void> => {
    for (const [key, value] of Object.entries(configOf(covered, game, accounts))) await git(instanceRoot, 'config', key, value);
  };
  // An unset key is exit code 5.
  const configTakenBack = (files: readonly CoveredFile[]): Undo => async () => {
    for (const key of Object.keys(configOf(files, undefined, accountTokens('')))) {
      await git(instanceRoot, 'config', '--unset-all', key).catch((err: unknown) => {
        if (typeof err !== 'object' || err === null || !('code' in err) || err.code !== 5) throw err;
      });
    }
  };

  const written = async (takeBack: Undo[]): Promise<string | undefined> => {
    const added = await filesNotWritten(instanceRoot, covered);
    takeBack.push(await attributesWritten(instanceRoot, covered));
    const files = (await filesGitHolds(instanceRoot, covered)).flatMap(({ file, covered: isCovered }) => (isCovered ? [file] : []));
    const accounts = accountTokens(await get(settingsFile(instanceRoot), ''));
    takeBack.push(configTakenBack(added));
    await configWritten(undefined, accounts);
    await withScratch((scratch) => smudged(scratch, instanceRoot, files));
    const game = await gameFolder();
    await configWritten(foundRoot(game), accounts);
    const holding = await withScratch((scratch) => smudged(scratch, instanceRoot, files));
    await statsForgotten(instanceRoot, files);
    if (holding.length === 0) return undefined;
    const why = game.kind === 'found' ? `${instanceRoot} or ${game.root} is on no drive or network share` : 'the game folder was not found';
    return `${holding.join(', ')} still hold${holding.length === 1 ? 's' : ''} a path token in place of this machine's path, because ${why}`;
  };

  return {
    // A failed write takes back what it added: its attribute lines, and each filter the repository did not hold.
    async writePathTokens() {
      if (!(await isRepository(instanceRoot))) return undefined;
      const takeBack: Undo[] = [];
      try {
        return await written(takeBack);
      } catch (err) {
        throw await undoAll(takeBack.reverse(), err);
      }
    },

    async pathsOutsideFolders() {
      if (!(await isRepository(instanceRoot))) return [];
      const files = await filesGitHolds(instanceRoot, covered);
      return withScratch(async (scratch) => {
        const found = [];
        for (const { file, covered } of files) {
          if (GIT_PATTERN_FILES.has(basename(file))) continue;
          const text = covered ? await heldByGit(scratch, instanceRoot, file) : await readFile(join(instanceRoot, file), 'utf8').catch(absentAs(''));
          if (text.includes('\0')) continue;
          found.push(...[...new Set(pathsIn(text))].map((path) => ({ file, path })));
        }
        return found;
      });
    },
  };
}
