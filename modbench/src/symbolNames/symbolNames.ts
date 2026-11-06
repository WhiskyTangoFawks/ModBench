/** A plugin as a symbol: its file name, with the mod that holds it (ADR-0012). */
export interface PluginSymbol {
  readonly name: string;
  readonly origin: string;
}

/** How a file names a plugin: by its file name alone, or with the mod that holds it. */
export interface PluginName {
  readonly name: string;
  readonly origin?: string;
}

/** A plugin row of the instance: whether mod order resolves its file name to it. */
export interface ResolvedPlugin extends PluginSymbol {
  readonly winning: boolean;
}

/** Where the game takes a file from: a mod, or the files it wrote at run time. */
export type RankedOrigin = { readonly kind: 'mod'; readonly name: string } | { readonly kind: 'runtimeOutput' };

/** The origins a file name resolves through, winning first: the run-time output, then each enabled mod of `modOrder`,
 *  which lists them winning first. A name no origin holds resolves to the game's Data folder. */
export const originsWinningFirst = (modOrder: readonly { readonly kind: string; readonly name: string; readonly enabled: boolean }[]): RankedOrigin[] => [
  { kind: 'runtimeOutput' },
  ...modOrder.flatMap((entry): RankedOrigin[] => (entry.kind === 'mod' && entry.enabled ? [{ kind: 'mod', name: entry.name }] : [])),
];

/** Whether two plugin file names, or two mod names, name one thing: the game compares them in any case. */
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const samePlugin = (a: PluginSymbol, b: PluginSymbol): boolean => sameName(a.name, b.name) && sameName(a.origin, b.origin);

/** The plugin `named` names: with its mod, that copy; by its file name alone, the copy mod order resolves it to, if any. */
export function pluginNamed({ name, origin }: PluginName, plugins: readonly ResolvedPlugin[]): PluginSymbol | undefined {
  if (origin !== undefined) return { name, origin };
  const resolved = plugins.find((plugin) => plugin.winning && sameName(plugin.name, name));
  return resolved && { name: resolved.name, origin: resolved.origin };
}

export function namesPlugin(named: PluginName, symbol: PluginSymbol, plugins: readonly ResolvedPlugin[]): boolean {
  const resolved = pluginNamed(named, plugins);
  return resolved !== undefined && samePlugin(resolved, symbol);
}

export interface TextPosition {
  readonly line: number;
  readonly character: number;
}

/** A span of a file's text, by zero-based line and character. */
export interface PlaceInFile {
  readonly file: string;
  readonly start: TextPosition;
  readonly end: TextPosition;
}

function positionAt(text: string, offset: number): TextPosition {
  const before = text.slice(0, offset).split(/\r\n|\r|\n/);
  return { line: before.length - 1, character: before.at(-1)?.length ?? 0 };
}

/** The place of the span `start` to `end` of `text`, the text of `file`. */
export const placeIn = (file: string, text: string, start: number, end: number): PlaceInFile =>
  ({ file, start: positionAt(text, start), end: positionAt(text, end) });

/** The offset of `position` in `text`. */
export function offsetOf(text: string, { line, character }: TextPosition): number {
  const lineBreak = line === 0 ? undefined : [...text.matchAll(/\r\n|\r|\n/g)][line - 1];
  return (lineBreak === undefined ? 0 : lineBreak.index + lineBreak[0].length) + character;
}

/** A record's copy in a plugin, whose document Source opens to find where it names the symbol. */
export interface CopyNaming {
  readonly formKey: string;
  readonly plugin: PluginSymbol;
}

/** Where a file names a plugin, and how it names it. */
export type SymbolReference = ({ readonly place: PlaceInFile } | { readonly copy: CopyNaming }) & { readonly names: PluginName };

/** The references an owner found, and why it left out each file it could not read. */
export interface SymbolReading {
  readonly references: readonly SymbolReference[];
  readonly leftOut: readonly string[];
}

/** Unsaved text by its file's path, read in place of the file. */
export interface HeldTexts {
  readonly byPath: ReadonlyMap<string, string>;
}

// A Windows path's drive letter is spelled in either case, VS Code's in lower case.
const heldKey = (path: string): string => path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());

export const heldTexts = (entries: Iterable<readonly [path: string, text: string]>): HeldTexts =>
  ({ byPath: new Map([...entries].map(([path, text]) => [heldKey(path), text])) });

export const heldTextAt = ({ byPath }: HeldTexts, path: string): string | undefined => byPath.get(heldKey(path));

/** Whether two paths, as VS Code and the instance spell them, are one file. */
export const samePath = (a: string, b: string): boolean => heldKey(a) === heldKey(b);

/** Changes to files by absolute path, which Text documents applies: each move, then each deletion, then each
 *  document's text. */
export interface FileChanges {
  readonly moves: readonly { readonly from: string; readonly to: string }[];
  readonly deletions: readonly string[];
  readonly documents: readonly { readonly path: string; readonly text: string }[];
}

export const NO_FILE_CHANGES: FileChanges = { moves: [], deletions: [], documents: [] };

/** An owner's write: why it failed, or each reference it could not carry once it wrote. */
export type Committed = { readonly failed: string } | { readonly cannotFollow: readonly string[] };

export const COMMITTED: Committed = { cannotFollow: [] };

/** An owner's part of a rename, with nothing written: the changes Text documents applies, each reference that cannot
 *  follow, and the owner's own write once every owner's changes are applied. */
export interface RenamePlan {
  readonly changes: FileChanges;
  readonly cannotFollow: readonly string[];
  commit(): Promise<Committed>;
}

export type Planned = RenamePlan | { readonly refused: string };

/** A symbol its name alone names: a mod, a mod separator, a downloaded file or a profile (symbols.md, The symbols). */
export interface EntrySymbol {
  readonly kind: 'mod' | 'separator' | 'downloadedFile' | 'profile';
  readonly name: string;
}

/** The places a box's files name a symbol its name alone names, and why it left out each file it could not read. */
export interface EntryReading {
  readonly references: readonly PlaceInFile[];
  readonly leftOut: readonly string[];
}

/** An entry, and the span of a file's text that names it, by offset. */
export interface EntryNamed {
  readonly entry: EntrySymbol;
  readonly start: number;
  readonly end: number;
}

/** An entry and the place a file names it. */
export interface EntryPlace {
  readonly entry: EntrySymbol;
  readonly place: PlaceInFile;
}

/** A box that owns files, saying where they name a symbol its name alone names (ADR-0028). */
export interface EntryNames {
  /** Where its files name each symbol of `kind`, from one read of each file. For mods and separators, the Instance
   *  adapter's is the active profile's mod list alone. */
  listed(kind: EntrySymbol['kind'], held: HeldTexts): Promise<readonly EntryPlace[]>;
  read(entry: EntrySymbol, held: HeldTexts): Promise<EntryReading>;
  /** The symbol one of its files names at `offset` of the file's `text`, and the span of the text that names it;
   *  undefined where it names none. */
  nameAt(file: string, text: string, offset: number): Promise<EntryNamed | undefined>;
}

/** A box that owns files naming a symbol its name alone names, in its part of a rename. */
export interface EntryOwner<Symbol extends EntrySymbol = EntrySymbol> {
  plan(symbol: Symbol, newName: string, held: HeldTexts): Promise<Planned>;
}

/** `text` with each span replaced by what `spelled` makes of the text at its start. */
export const spliced = (text: string, spans: readonly { readonly start: number; readonly end: number }[], spelled: (start: number) => string): string =>
  [...spans].sort((a, b) => b.start - a.start).reduce((after, { start, end }) => after.slice(0, start) + spelled(start) + after.slice(end), text);

/** A box that owns files, saying where they name a symbol (ADR-0028). */
export interface SymbolOwner {
  read(symbol: PluginSymbol, held: HeldTexts): Promise<SymbolReading>;
  /** Its part of renaming `symbol` to `newName`, or why it refuses the rename. A name alone names the copy `plugins`,
   *  the rows of its file name, resolve it to. */
  plan(symbol: PluginSymbol, newName: string, held: HeldTexts, plugins: readonly ResolvedPlugin[]): Promise<Planned>;
  /** The plugin one of its files names at `offset` of the file's `text`; undefined where it names none. */
  nameAt(file: string, text: string, offset: number): Promise<PluginName | undefined>;
}
