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

const sameText = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const samePlugin = (a: PluginSymbol, b: PluginSymbol): boolean => sameText(a.name, b.name) && sameText(a.origin, b.origin);

/** Whether `named` names `symbol`: with its mod, that copy; by its file name alone, the copy mod order resolves it to. */
export function namesPlugin(named: PluginName, symbol: PluginSymbol, plugins: readonly ResolvedPlugin[]): boolean {
  const { name, origin } = named;
  const resolved = origin === undefined ? plugins.find((plugin) => plugin.winning && sameText(plugin.name, name)) : { name, origin };
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
export type HeldTexts = ReadonlyMap<string, string>;

/** A box that owns files, saying where they name a symbol (ADR-0028). */
export interface SymbolOwner {
  read(symbol: PluginSymbol, held: HeldTexts): Promise<SymbolReading>;
}
