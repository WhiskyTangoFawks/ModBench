// modlist-repository.md, The repository, story 4. Git runs the filter with no Modbench running, so it is sed, which git
// ships on Windows too. The filter is the one program that tokenizes and restores.

/** This machine's folders a token names; a folder not found has no token. */
export interface TokenFolders {
  readonly instance: string;
  readonly game: string | undefined;
}

// How a file spells a path: the separator after its root, then between its names.
interface Separator {
  readonly first: string;
  readonly rest: string;
}

/** How a file spells a path: as a Windows program does, which on Linux is through Wine, or natively, as this machine's
 *  own programs do. A path ends at a separator, one of `ends` or its line's end. */
export interface PathSpelling {
  readonly native: boolean;
  /** Each separator of a Windows path; a native token stands for them all, and puts back the first. */
  readonly separators: readonly Separator[];
  readonly ends: string;
}

/** The sed expressions that put each token in place of its value, and each value back. */
export interface TokenProgram {
  readonly clean: readonly string[];
  readonly smudge: readonly string[];
}

interface Spelling {
  readonly token: string;
  readonly text: string;
  readonly caseless: (index: number) => boolean;
}

interface Rooted {
  readonly root: (separator: Separator) => string;
  readonly segments: readonly string[];
}

const segmentsOf = (path: string): string[] => path.split(/[\\/]+/).filter((segment) => segment !== '');

// A Windows program spells a path on a drive or a share, whose root is its name separator twice. Wine's drive Z is the
// root, and drive C its prefix's drive_c, which the program names first.
function rootings(folder: string, platform: NodeJS.Platform): Rooted[] {
  if (platform === 'win32') {
    const drive = /^([A-Za-z]):[\\/]/.exec(folder)?.[1]?.toUpperCase();
    if (drive !== undefined) return [{ root: ({ first }) => `${drive}:${first}`, segments: segmentsOf(folder.slice(2)) }];
    return /^[\\/]{2}[^\\/]/.test(folder) ? [{ root: ({ rest }) => rest + rest, segments: segmentsOf(folder) }] : [];
  }
  if (!folder.startsWith('/')) return [];
  const segments = segmentsOf(folder);
  const onZ: Rooted = { root: ({ first }) => `Z:${first}`, segments };
  const driveC = segments.indexOf('drive_c');
  return driveC === -1 ? [onZ] : [{ root: ({ first }) => `C:${first}`, segments: segments.slice(driveC + 1) }, onZ];
}

const POSIX: Separator = { first: '/', rest: '/' };

function spellingsOf(name: string, folder: string | undefined, platform: NodeJS.Platform, { native, separators }: PathSpelling): Spelling[] {
  if (folder === undefined) return [];
  const caseless = platform === 'win32' ? () => true : (index: number) => index === 0;
  const posix = native && platform !== 'win32';
  const rooted = posix ? [{ root: ({ first }: Separator) => first, segments: segmentsOf(folder) }] : rootings(folder, platform);
  return rooted.flatMap(({ root, segments }) => (segments.length === 0 ? [] : (posix ? [POSIX] : separators).map((separator) => ({
    token: native ? `{${name}}` : `{${name}:${separator.first}}`, text: root(separator) + segments.join(separator.rest), caseless,
  }))));
}

function isInside(folder: string, parent: string, platform: NodeJS.Platform): boolean {
  const [inner, outer, separator] = platform === 'win32'
    ? [folder.toLowerCase().replaceAll('/', '\\'), parent.toLowerCase().replaceAll('/', '\\'), '\\'] : [folder, parent, '/'];
  return inner === outer || inner.startsWith(outer.endsWith(separator) ? outer : outer + separator);
}

/** `text` matched as itself by sed. */
export const sedLiteral = (text: string): string => text.replace(/[\\.*[\]^$|]/g, '\\$&');

/** `text` written as itself by sed. */
export const sedReplacement = (text: string): string => text.replace(/[\\&|]/g, '\\$&');

const patternOf = ({ text, caseless }: Spelling): string =>
  text.replace(/./gs, (character: string, index: number) => (caseless(index) && /[A-Za-z]/.test(character)
    ? `[${character.toLowerCase()}${character.toUpperCase()}]` : sedLiteral(character)));

const firstOfEach = (spellings: readonly Spelling[]): Spelling[] =>
  spellings.filter((spelling, at) => spellings.findIndex(({ token }) => token === spelling.token) === at);

/** The folders' tokens in `spelling`. A game folder inside the instance folder takes the instance folder's token, so a
 *  clone finds its own. */
export function folderTokens({ instance, game }: TokenFolders, platform: NodeJS.Platform, spelling: PathSpelling): TokenProgram {
  const instanceSpellings = spellingsOf('instance folder', instance, platform, spelling);
  const gameSpellings = spellingsOf('game folder', game, platform, spelling);
  const cleaned = [...instanceSpellings, ...(game !== undefined && isInside(game, instance, platform) ? [] : gameSpellings)]
    .sort((a, b) => b.text.length - a.text.length);
  const boundary = `[/\\\\${spelling.ends}[:cntrl:]]`;
  return {
    clean: cleaned.flatMap((spelling) => {
      const [pattern, token] = [patternOf(spelling), sedReplacement(spelling.token)];
      return [`s|${pattern}\\(${boundary}\\)|${token}\\1|g`, `s|${pattern}$|${token}|`];
    }),
    smudge: firstOfEach([...instanceSpellings, ...gameSpellings]).map(({ token, text }) => `s|${sedLiteral(token)}|${sedReplacement(text)}|g`),
  };
}

const shellQuoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

// The sed git ships on Windows drops each carriage return unless --binary.
const sed = (expressions: readonly string[]): string =>
  (expressions.length === 0 ? 'cat' : `LC_ALL=C sed --binary ${expressions.map((expression) => `-e ${shellQuoted(expression)}`).join(' ')}`);

/** The git config that makes git hold each file `driver` covers by its tokens, and refuse a file the filter fails on. */
export function tokenFilterConfig(driver: string, ...programs: readonly TokenProgram[]): Readonly<Record<string, string>> {
  const smudge = sed(programs.flatMap((program) => program.smudge));
  return {
    [`filter.${driver}.clean`]: sed(programs.flatMap((program) => program.clean)),
    [`filter.${driver}.smudge`]: smudge,
    [`filter.${driver}.required`]: 'true',
    [`diff.${driver}.textconv`]: smudge,
  };
}

/** Whether `text` holds a token in place of a folder's path. */
export const holdsPathToken = (text: string): boolean => /\{(?:instance|game) folder[:}]/.test(text);
