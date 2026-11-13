import type * as vscode from 'vscode';
import type { Reveal } from '../drivingLib/symbolRows';
import type { TextSpan } from '../drivingLib/sourceText';
import type { CopyAt } from '../instanceLoader/fileConflictIndex';
import type { EntrySymbol, PluginName, ScriptSymbol } from '../symbolNames/symbolNames';
import type { AskedIn } from './symbolPlaces';

type PluginNamed = { readonly kind: 'plugin' } & PluginName;
type RecordNamed = { readonly kind: 'record'; readonly formKey: string };
type FileNamed = { readonly kind: 'file'; readonly path: string };

/** A symbol by its name: a record by its FormKey, a file by its path in the Data folder. */
export type SymbolName = PluginNamed | RecordNamed | EntrySymbol | ScriptSymbol | FileNamed;

/** Where a symbol is defined (symbols.md, The symbols): a place or a file to open, a row to select in the view `row`
 *  names, or a copy to show in the Explorer; else why it has none. */
export type Definition =
  | { readonly at: vscode.Location }
  | { readonly file: string }
  | { readonly row: string; readonly show: Reveal }
  | { readonly shown: CopyAt }
  | { readonly none: string }
  | { readonly refused: string };

/** Each place a file names a symbol, and why each file went unread; or why the symbol names nothing to list. */
export type References =
  | { readonly locations: readonly vscode.Location[]; readonly unread: readonly string[] }
  | { readonly refused: string };

type Refused = { readonly refused: string };

/** The span of a file's text that names a symbol, as the text spells it, and the symbol, or why it names none. */
export interface Named<Symbol> extends TextSpan {
  readonly spelled: string;
  readonly symbol: Symbol | Refused;
}

/** A symbol as Go to Symbol in Workspace lists it. `resolve`, on the symbol the user picks, says where it opens, or
 *  leaves `location`. */
export interface Listed {
  readonly name: string;
  readonly detail: string;
  readonly icon: vscode.SymbolKind;
  readonly location: vscode.Location;
  readonly resolve?: () => Promise<vscode.Location | undefined>;
}

/** One kind of symbol, giving every entry point one answer (symbols.md; ADR-0028). */
export interface SymbolKind<Symbol> {
  nameAt(document: AskedIn, offset: number): Promise<Named<Symbol> | undefined>;
  definitionOf(symbol: Symbol): Promise<Definition>;
  referencesTo(symbol: Symbol): Promise<References>;
  /** The hover's lines; undefined offers no hover. */
  hoverOf(named: Named<Symbol>): Promise<readonly string[] | undefined>;
  /** What completion offers over the span where a file names a symbol of the kind. */
  completionsAt(document: AskedIn, offset: number): Promise<(TextSpan & {
    readonly icon: vscode.CompletionItemKind;
    readonly items: readonly { readonly label: string; readonly detail?: string; readonly insertText?: string }[];
    readonly isIncomplete?: boolean;
  }) | undefined>;
  symbolsFor(query: string): Promise<readonly Listed[]>;
}

export interface SymbolKinds {
  readonly plugin: SymbolKind<PluginNamed>;
  readonly record: SymbolKind<RecordNamed>;
  readonly entry: SymbolKind<EntrySymbol>;
  readonly script: SymbolKind<ScriptSymbol>;
  readonly file: SymbolKind<FileNamed>;
}

/** A symbol, with its kind's answers. */
export interface Asked {
  definition(): Promise<Definition>;
  references(): Promise<References>;
}

/** A symbol's name in a file, with its kind's answers. */
export interface AskedAt extends Asked, TextSpan {
  readonly spelled: string;
  hover(): Promise<readonly string[] | undefined>;
}

const namesNothing = (symbol: object): symbol is Refused => 'refused' in symbol;

const askedOf = <Symbol extends object>(kind: SymbolKind<Symbol>, symbol: Symbol | Refused): Asked => ({
  definition: () => (namesNothing(symbol) ? Promise.resolve(symbol) : kind.definitionOf(symbol)),
  references: () => (namesNothing(symbol) ? Promise.resolve(symbol) : kind.referencesTo(symbol)),
});

const claimOf = (kind: SymbolKind<object>) => async (document: AskedIn, offset: number): Promise<AskedAt | undefined> => {
  const named = await kind.nameAt(document, offset);
  return named && { ...askedOf(kind, named.symbol), start: named.start, end: named.end, spelled: named.spelled, hover: () => kind.hoverOf(named) };
};

/** The kinds in the order they claim a span: a plugin's name inside a FormKey is the plugin's, not the record's. */
export const inOrder = ({ plugin, entry, script, file, record }: SymbolKinds) => [plugin, entry, script, file, record];

/** The symbol the document names at `offset`, from the first kind that claims it; undefined where it names none. */
export async function askedAt(kinds: SymbolKinds, document: AskedIn, offset: number): Promise<AskedAt | undefined> {
  for (const kind of inOrder(kinds)) {
    const found = await claimOf(kind)(document, offset);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function asked(kinds: SymbolKinds, symbol: SymbolName): Asked {
  switch (symbol.kind) {
    case 'plugin': return askedOf(kinds.plugin, symbol);
    case 'record': return askedOf(kinds.record, symbol);
    case 'script': return askedOf(kinds.script, symbol);
    case 'file': return askedOf(kinds.file, symbol);
    case 'mod': case 'separator': case 'downloadedFile': case 'profile': return askedOf(kinds.entry, symbol);
  }
}
