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

/** A box that owns files, saying where they name a symbol (ADR-0028). */
export interface SymbolOwner {
  read(symbol: PluginSymbol, held: HeldTexts): Promise<SymbolReading>;
  /** The plugin one of its files names at `offset` of the file's `text`; undefined where it names none. */
  nameAt(file: string, text: string, offset: number): Promise<PluginName | undefined>;
}
