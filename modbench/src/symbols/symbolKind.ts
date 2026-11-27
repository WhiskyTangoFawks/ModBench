import type * as vscode from 'vscode';
import type { Reveal } from '../drivingLib/symbolRows';
import type { CopyAt } from '../instanceLoader/fileConflictIndex';
import type { EntrySymbol, PluginName, ScriptSymbol, TextSpan } from '../symbolNames/symbolNames';
import type { PluginRecords } from '../drivingLib/namedPlugins';
import type { AskedIn } from './symbolPlaces';

export type PluginNamed = { readonly kind: 'plugin' } & PluginName;
export type RecordNamed = { readonly kind: 'record'; readonly formKey: string };
export type FileNamed = { readonly kind: 'file'; readonly path: string };

/** The symbol of a kind that has a row: never a record or a script, the only kinds whose definition is a place. */
export type RowSymbol = PluginNamed | EntrySymbol | FileNamed;

/** A symbol by its name: a record by its FormKey, a file by its path in the Data folder. */
export type SymbolName = RowSymbol | RecordNamed | ScriptSymbol;

/** A row to select in the view `row` names, or a copy to show in the Explorer. */
export type Presented = { readonly row: string; readonly show: Reveal } | { readonly shown: CopyAt };

export type Shown = Presented | { readonly at: vscode.Location } | { readonly file: string };

/** Where a symbol is defined (symbols.md, The symbols): a place or a file to open, or what is presented; else why it has
 *  none. */
export type Definition<Of extends Shown = Shown> = Of | { readonly none: string } | { readonly refused: string };

/** Each place a file names a symbol, and why each file went unread; or why the symbol names nothing to list. */
export type References =
  | { readonly locations: readonly vscode.Location[]; readonly unread: readonly string[] }
  | { readonly refused: string };

type Refused = { readonly refused: string };

/** The span of a file's text that names a symbol, the symbol's name, and the symbol, or why it names none. */
export interface Named<Symbol> extends TextSpan {
  readonly name: string;
  readonly symbol: Symbol | Refused;
}

/** A name a document holds that names nothing, over its span, and why. */
export interface NamesNothing extends TextSpan {
  readonly name: string;
  readonly why: string;
}

/** A search for symbols by name: the gesture the user ran, which the Output names, and whether a later keystroke has
 *  superseded it. */
export interface SymbolSearch {
  readonly gesture: string;
  readonly cancelled: () => boolean;
}

/** A symbol as Go to Symbol in Workspace lists it. `resolve`, on the symbol the user picks, says where it opens, or
 *  leaves `location`; it rejects where the symbol opens nowhere, having said why, so VS Code opens nothing. */
export interface Listed {
  readonly symbol: SymbolName;
  readonly name: string;
  readonly detail: string;
  readonly icon: vscode.SymbolKind;
  readonly location: vscode.Location;
  readonly resolve?: () => Promise<vscode.Location | undefined>;
}

/** One kind of symbol, giving every entry point one answer (symbols.md; ADR-0028). */
export interface SymbolKind<Symbol, Of extends Shown = Shown> {
  nameAt(document: AskedIn, offset: number, token?: vscode.CancellationToken): Promise<Named<Symbol> | undefined>;
  definitionOf(symbol: Symbol, token?: vscode.CancellationToken): Promise<Definition<Of>>;
  referencesTo(symbol: Symbol, token?: vscode.CancellationToken): Promise<References>;
  /** `referenced by`: shows what references the symbol in VS Code's References view, reporting what it could not list. */
  referencedBy(symbol: Symbol): Promise<void>;
  /** What its row's tooltip says, a line to each line; none where it has no row or no tooltip. */
  tooltipOf(symbol: Symbol, token?: vscode.CancellationToken): Promise<readonly string[]>;
  /** What completion offers over the span where a file names a symbol of the kind, asking nothing further once the
   *  search is cancelled. */
  completionsAt(document: AskedIn, offset: number, search: SymbolSearch): Promise<(TextSpan & {
    readonly icon: vscode.CompletionItemKind;
    readonly items: readonly { readonly label: string; readonly detail?: string; readonly insertText?: string }[];
    readonly isIncomplete?: boolean;
  }) | undefined>;
  /** Each name in the document that names nothing (symbols.md, The features, story 8). None where judging has stopped
   *  for a reason that lasts; undefined while the instance has not read what would hold them. */
  namesNothingIn?(document: AskedIn): Promise<readonly NamesNothing[] | undefined>;
  /** Each file, open or not, that holds a name that names nothing, from one ask of its owner; `only` asks of those
   *  plugins' files. None where judging has stopped; undefined where nothing can be said yet. */
  filesNamingNothing?(only?: readonly PluginRecords[]): Promise<readonly string[] | undefined>;
  /** Each symbol of the kind whose name holds `query`, which is trimmed and never empty, asking nothing further once the
   *  search is cancelled. */
  symbolsFor(query: string, search: SymbolSearch): Promise<readonly Listed[]>;
}

export interface SymbolKinds {
  readonly plugin: SymbolKind<PluginNamed, Presented>;
  readonly record: SymbolKind<RecordNamed>;
  readonly entry: SymbolKind<EntrySymbol, Presented>;
  readonly script: SymbolKind<ScriptSymbol>;
  readonly file: SymbolKind<FileNamed, Presented>;
}

interface Asked<Of extends Shown = Shown> {
  definition(token?: vscode.CancellationToken): Promise<Definition<Of>>;
  references(token?: vscode.CancellationToken): Promise<References>;
}

/** A symbol, with its kind's answers and `referenced by`. */
export interface AskedSymbol<Of extends Shown = Shown> extends Asked<Of> {
  referencedBy(): Promise<void>;
}

/** A symbol's name in a file, with its kind's answers. */
export interface AskedAt extends Asked, TextSpan {
  readonly name: string;
  /** What a hover says: its row's tooltip, and with no row or no tooltip, its name (symbols.md, The symbols). */
  hover(token?: vscode.CancellationToken): Promise<readonly string[]>;
}

const namesNothing = (symbol: object): symbol is Refused => 'refused' in symbol;

const askedOf = <Symbol extends object, Of extends Shown>(kind: SymbolKind<Symbol, Of>, symbol: Symbol | Refused): Asked<Of> => ({
  definition: (token) => (namesNothing(symbol) ? Promise.resolve(symbol) : kind.definitionOf(symbol, token)),
  references: (token) => (namesNothing(symbol) ? Promise.resolve(symbol) : kind.referencesTo(symbol, token)),
});

const askedSymbolOf = <Symbol extends object, Of extends Shown>(kind: SymbolKind<Symbol, Of>, symbol: Symbol): AskedSymbol<Of> => ({
  ...askedOf(kind, symbol),
  referencedBy: () => kind.referencedBy(symbol),
});

const claimOf = (kind: SymbolKind<object>) => async (document: AskedIn, offset: number, token?: vscode.CancellationToken): Promise<AskedAt | undefined> => {
  const named = await kind.nameAt(document, offset, token);
  if (named === undefined) return undefined;
  const { start, end, name, symbol } = named;
  const hover = async (hoverToken?: vscode.CancellationToken): Promise<readonly string[]> => {
    const tooltip = namesNothing(symbol) ? [] : await kind.tooltipOf(symbol, hoverToken);
    return tooltip.length > 0 ? tooltip : [name];
  };
  return { ...askedOf(kind, symbol), start, end, name, hover };
};

/** The kinds in the order they claim a span: a plugin's name inside a FormKey is the plugin's, not the record's. */
export const inOrder = ({ plugin, entry, script, file, record }: SymbolKinds) => [plugin, entry, script, file, record];

/** The symbol the document names at `offset`, from the first kind that claims it; undefined where it names none. */
export async function askedAt(kinds: SymbolKinds, document: AskedIn, offset: number, token?: vscode.CancellationToken): Promise<AskedAt | undefined> {
  for (const kind of inOrder(kinds)) {
    const found = await claimOf(kind)(document, offset, token);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function asked(kinds: SymbolKinds, symbol: RowSymbol): AskedSymbol<Presented>;
export function asked(kinds: SymbolKinds, symbol: SymbolName): AskedSymbol;
export function asked(kinds: SymbolKinds, symbol: SymbolName): AskedSymbol {
  switch (symbol.kind) {
    case 'plugin': return askedSymbolOf(kinds.plugin, symbol);
    case 'record': return askedSymbolOf(kinds.record, symbol);
    case 'script': return askedSymbolOf(kinds.script, symbol);
    case 'file': return askedSymbolOf(kinds.file, symbol);
    case 'mod': case 'separator': case 'downloadedFile': case 'profile': return askedSymbolOf(kinds.entry, symbol);
  }
}

/** `referenced by`, as the Output names it. */
export const REFERENCED_BY = 'Referenced By';

/** Each symbol, of any kind, whose name holds `query`: what Go to Symbol in Workspace lists. */
export async function listedSymbols(kinds: SymbolKinds, query: string, search: SymbolSearch): Promise<Listed[]> {
  const wanted = query.trim();
  if (wanted === '') return [];
  return (await Promise.all(inOrder(kinds).map((kind) => kind.symbolsFor(wanted, search)))).flat();
}
