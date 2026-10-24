// modlist-repository.md, The repository, story 4. Git runs the filter with no Modbench running, so it is sed, which git
// ships on Windows too. The filter is the one program that tokenizes and restores.

/** This machine's folders a token names; a folder not found has no token. */
export interface TokenFolders {
  readonly instance: string;
  readonly game: string | undefined;
  readonly downloads: string | undefined;
  /** The folders the commit holds by their own token, though a folder can sit inside the instance folder here: a clone
   *  cleans back what it smudged. */
  readonly committedOutsideInstance: readonly FolderName[];
}

export type FolderName = 'game folder' | 'downloads folder';

interface Separator {
  readonly first: string;
  readonly rest: string;
}

/** How a file spells a path: as a Windows program does, on Wine on Linux, and in a native file as this machine does,
 *  after a line start or a `nativeStarts`. A path ends at a separator or an `ends`. */
export interface PathSpelling {
  readonly separators: readonly Separator[];
  readonly ends: string;
  readonly nativeStarts?: readonly string[];
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
  /** The sed group a path starts after. */
  readonly start: string;
}

interface Rooted {
  readonly root: (separator: Separator) => string;
  readonly segments: readonly string[];
  readonly start: string;
}

const segmentsOf = (path: string): string[] => path.split(/[\\/]+/).filter((segment) => segment !== '');

const startAfter = (alternatives: readonly string[]): string => `\\(${['^', ...alternatives].join('\\|')}\\)`;

// A drive's letter follows no name's character in a path; a share's root can follow a drive's, and a POSIX path a name.
const DRIVE_START = startAfter(['[^A-Za-z0-9]']);
const SHARE_START = startAfter(['[^A-Za-z0-9:/\\\\]']);

// A Windows program spells a path on a drive or a share, whose root is its name separator twice. Wine's drive Z is the
// root, and drive C its prefix's drive_c, which the program names first.
function rootings(folder: string, platform: NodeJS.Platform): Rooted[] {
  if (platform === 'win32') {
    const drive = /^([A-Za-z]):[\\/]/.exec(folder)?.[1]?.toUpperCase();
    if (drive !== undefined) return [{ root: ({ first }) => `${drive}:${first}`, segments: segmentsOf(folder.slice(2)), start: DRIVE_START }];
    return /^[\\/]{2}[^\\/]/.test(folder) ? [{ root: ({ rest }) => rest + rest, segments: segmentsOf(folder), start: SHARE_START }] : [];
  }
  if (!folder.startsWith('/')) return [];
  const segments = segmentsOf(folder);
  const onZ: Rooted = { root: ({ first }) => `Z:${first}`, segments, start: DRIVE_START };
  const driveC = segments.indexOf('drive_c');
  return driveC === -1 ? [onZ] : [{ root: ({ first }) => `C:${first}`, segments: segments.slice(driveC + 1), start: DRIVE_START }, onZ];
}

const POSIX: Separator = { first: '/', rest: '/' };

function spellingsOf(name: string, folder: string | undefined, platform: NodeJS.Platform, { separators, nativeStarts }: PathSpelling): Spelling[] {
  if (folder === undefined) return [];
  const caseless = platform === 'win32' ? () => true : (index: number) => index === 0;
  const spelt = (rooted: readonly Rooted[], over: readonly Separator[], token: (separator: Separator) => string): Spelling[] =>
    rooted.flatMap(({ root, segments, start }) => (segments.length === 0 ? [] : over.map((separator) => ({
      token: token(separator), text: root(separator) + segments.join(separator.rest), caseless, start,
    }))));
  const windows = spelt(rootings(folder, platform), separators, ({ first }) => `{${name}:${first}}`);
  if (nativeStarts === undefined) return windows;
  const own = platform === 'win32'
    ? spelt(rootings(folder, platform), separators, () => `{${name}}`)
    : spelt([{ root: ({ first }) => first, segments: segmentsOf(folder), start: startAfter(nativeStarts.map(sedLiteral)) }], [POSIX], () => `{${name}}`);
  return [...own, ...windows];
}

function isInside(folder: string, parent: string, platform: NodeJS.Platform): boolean {
  const [inner, outer, separator] = platform === 'win32'
    ? [folder.toLowerCase().replaceAll('/', '\\'), parent.toLowerCase().replaceAll('/', '\\'), '\\'] : [folder, parent, '/'];
  return inner === outer || inner.startsWith(outer.endsWith(separator) ? outer : outer + separator);
}

// The delimiter is no character a regular expression needs, so `\|` is sed's alternation.
const DELIMITER = '#';

/** `text` matched as itself by sed. */
export const sedLiteral = (text: string): string => text.replace(/[\\.*[\]^$#]/g, '\\$&');

/** `text` written as itself by sed. */
export const sedReplacement = (text: string): string => text.replace(/[\\&#]/g, '\\$&');

/** The sed expression that puts `replacement` in place of what `pattern` matches, its delimiter escaped in both. */
export const sedSubstitution = (pattern: string, replacement: string, flags = ''): string =>
  ['s', pattern, replacement, flags].join(DELIMITER);

const patternOf = ({ text, caseless }: Spelling): string =>
  text.replace(/./gs, (character: string, index: number) => (caseless(index) && /[A-Za-z]/.test(character)
    ? `[${character.toLowerCase()}${character.toUpperCase()}]` : sedLiteral(character)));

const firstOfEach = (spellings: readonly Spelling[], key: (spelling: Spelling) => string): Spelling[] =>
  spellings.filter((spelling, at) => spellings.findIndex((other) => key(other) === key(spelling)) === at);

/** The folders' tokens in `spelling`. A game or downloads folder inside the instance folder takes the instance folder's
 *  token, so a clone finds its own, unless a commit holds the folder by its own. */
export function folderTokens({ instance, game, downloads, committedOutsideInstance }: TokenFolders, platform: NodeJS.Platform, spelling: PathSpelling): TokenProgram {
  const instanceSpellings = spellingsOf('instance folder', instance, platform, spelling);
  const others = ([['game folder', game], ['downloads folder', downloads]] as const)
    .map(([name, folder]) => ({ folder: committedOutsideInstance.includes(name) ? undefined : folder, spellings: spellingsOf(name, folder, platform, spelling) }));
  const outside = others.flatMap(({ folder, spellings }) => (folder !== undefined && isInside(folder, instance, platform) ? [] : spellings));
  const cleaned = firstOfEach([...instanceSpellings, ...outside], ({ text }) => text)
    .sort((a, b) => b.text.length - a.text.length);
  const boundary = `[/\\\\${spelling.ends}[:cntrl:]]`;
  return {
    clean: cleaned.flatMap((spelt) => {
      const [start, pattern, token] = [spelt.start, patternOf(spelt), sedReplacement(spelt.token)];
      return [sedSubstitution(`${start}${pattern}\\(${boundary}\\)`, `\\1${token}\\2`, 'g'), sedSubstitution(`${start}${pattern}$`, `\\1${token}`)];
    }),
    smudge: firstOfEach([...instanceSpellings, ...others.flatMap(({ spellings }) => spellings)], ({ token }) => token)
      .map(({ token, text }) => sedSubstitution(sedLiteral(token), sedReplacement(text), 'g')),
  };
}

const shellQuoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** The git config that makes git hold each file a driver covers by its tokens, and the sed programs it names. */
export interface TokenFilter {
  readonly config: Readonly<Record<string, string>>;
  readonly programFiles: Readonly<Record<string, string>>;
}

// Windows cuts a command line at 32,767 characters, so a program rides in a file.
export function tokenFilter(driver: string, directory: string, ...programs: readonly TokenProgram[]): TokenFilter {
  const programFiles: Record<string, string> = {};
  const sed = (kind: 'clean' | 'smudge'): string => {
    const expressions = programs.flatMap((program) => program[kind]);
    const file = `${directory.replaceAll('\\', '/')}/${driver}.${kind}.sed`;
    programFiles[file] = expressions.map((expression) => `${expression}\n`).join('');
    // The sed git ships on Windows drops each carriage return unless --binary.
    return `LC_ALL=C sed --binary -f ${shellQuoted(file)}`;
  };
  const smudge = sed('smudge');
  return {
    config: {
      [`filter.${driver}.clean`]: sed('clean'),
      [`filter.${driver}.smudge`]: smudge,
      // A file the filter fails on is refused, not held as it is.
      [`filter.${driver}.required`]: 'true',
      [`diff.${driver}.textconv`]: smudge,
    },
    programFiles,
  };
}

/** Whether `text` holds a token in place of a folder's path. */
export const holdsPathToken = (text: string): boolean => /\{(?:instance|game|downloads) folder[:}]/.test(text);
