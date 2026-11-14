import * as vscode from 'vscode';
import type { ModRows, Reveal } from '../drivingLib/symbolRows';
import type { EntryRef, InstanceValue } from '../instanceLoader/instance';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { heldTexts, sameName, type EntryNames, type EntrySymbol, type PlaceInFile } from '../symbolNames/symbolNames';
import { heldText, unsavedTexts } from '../textDocuments/heldText';
import { atFile, nameHolds, placeLocation, readBy, showReferencedBy, tooltipLines, type AskedIn } from './symbolPlaces';
import { selectingItsRow } from './definitionShown';
import type { Definition, Listed, References, SymbolKind } from './symbolKind';

interface EntryLanguageDeps {
  instance: { readonly value: Pick<InstanceValue, 'mods' | 'downloadedFiles' | 'profiles'> } | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  owners: readonly EntryNames[];
  /** What Mods shows of its rows; absent with no instance. */
  rows: () => Pick<ModRows, 'show' | 'folderOf'> | undefined;
  /** The tooltip of the row Mods shows for a mod or a separator; undefined where it shows none. */
  entryTooltip: (entry: EntryRef) => string | undefined;
  /** The tooltip of the row Downloads shows for a downloaded file; undefined where it shows none. */
  downloadedFileTooltip: (name: string) => string | undefined;
  downloadedFileRow: (name: string) => Reveal | undefined;
  /** The file that holds the profile's mod order; undefined with no instance. */
  modOrderFileOf: (profile: string) => string | undefined;
  /** The mod's or the separator's `rename`, with the new name an entry point supplies. */
  renameEntry: (entry: RenamableEntry, newName: string) => Promise<void>;
}

export type RenamableEntry = EntrySymbol & { readonly kind: 'mod' | 'separator' };

const isRenamable = (entry: EntrySymbol): entry is RenamableEntry => entry.kind === 'mod' || entry.kind === 'separator';

const entryKey = ({ kind, name }: EntrySymbol): string => `${kind}:${name.toLowerCase()}`;

const KINDS = ['mod', 'separator', 'downloadedFile', 'profile'] as const;

const unlisted = ({ kind, name }: EntrySymbol): string => ({
  mod: `Mods lists no mod named ${name}.`,
  separator: `Mods lists no separator named ${name}.`,
  downloadedFile: `Downloads lists no downloaded file named ${name}.`,
  profile: `The instance holds no profile named ${name}.`,
})[kind];

const NOUNS: Record<EntrySymbol['kind'], string> = { mod: 'mod', separator: 'mod separator', downloadedFile: 'downloaded file', profile: 'profile' };

const SHOWN: Record<EntrySymbol['kind'], { readonly kind: vscode.SymbolKind; readonly completion: vscode.CompletionItemKind }> = {
  mod: { kind: vscode.SymbolKind.Package, completion: vscode.CompletionItemKind.Folder },
  separator: { kind: vscode.SymbolKind.Namespace, completion: vscode.CompletionItemKind.Folder },
  downloadedFile: { kind: vscode.SymbolKind.File, completion: vscode.CompletionItemKind.File },
  profile: { kind: vscode.SymbolKind.Module, completion: vscode.CompletionItemKind.Folder },
};

/** A mod, a separator, a downloaded file and a profile as symbols: wherever an owner's file names them, and the places
 *  files name them (symbols.md). */
export function entryLanguage({ instance, reporter, owners, rows, entryTooltip, downloadedFileTooltip, downloadedFileRow, modOrderFileOf, renameEntry }: EntryLanguageDeps) {
  // A profile has no row.
  const tooltip = ({ kind, name }: EntrySymbol): string | undefined => {
    if (kind === 'downloadedFile') return downloadedFileTooltip(name);
    return kind === 'profile' ? undefined : entryTooltip({ kind, name });
  };
  const listed = (kind: EntrySymbol['kind']): readonly string[] => {
    const value = instance?.value;
    if (value === undefined) return [];
    if (kind === 'profile') return value.profiles;
    if (kind === 'downloadedFile') return value.downloadedFiles.kind === 'listed' ? value.downloadedFiles.rows.map(({ name }) => name) : [];
    return value.mods.flatMap((entry) => (entry.kind === kind ? [entry.name] : []));
  };
  const ownFile = ({ kind, name }: EntrySymbol): string | undefined => {
    if (kind === 'profile') return modOrderFileOf(name);
    const files = instance?.value.downloadedFiles;
    return kind === 'downloadedFile' && files?.kind === 'listed' ? files.rows.find((row) => row.name === name)?.path : undefined;
  };
  const entryListed = ({ kind, name }: EntrySymbol): EntrySymbol | undefined => {
    const found = listed(kind).find((each) => sameName(each, name));
    return found === undefined ? undefined : { kind, name: found };
  };

  const read = async (entry: EntrySymbol) => {
    const readings = await Promise.all(owners.map((owner) => readBy(owner, entry, heldTexts(unsavedTexts()))));
    return { found: readings.flatMap(({ references }) => references), unread: readings.flatMap(({ leftOut }) => leftOut) };
  };

  const referencesTo = async (named: EntrySymbol): Promise<References> => {
    const entry = entryListed(named);
    if (entry === undefined) return { refused: unlisted(named) };
    const { found, unread } = await read(entry);
    return { locations: found.map(placeLocation), unread };
  };

  const kind: SymbolKind<EntrySymbol> = {
    async nameAt(document, offset) {
      for (const owner of owners) {
        const found = await owner.nameAt(document.uri.fsPath, heldText(document), offset);
        if (found !== undefined) return { start: found.start, end: found.end, name: found.entry.name, symbol: found.entry };
      }
      return undefined;
    },
    /** A mod's or a separator's row in Mods, a downloaded file's row in Downloads. A mod with no row is its folder. */
    definitionOf(named): Promise<Definition> {
      const entry = entryListed(named);
      if (entry === undefined) return Promise.resolve({ refused: unlisted(named) });
      if (entry.kind === 'profile') return Promise.resolve({ none: `A ${NOUNS[entry.kind]} has no definition.` });
      if (entry.kind === 'downloadedFile') {
        const show = downloadedFileRow(entry.name);
        return Promise.resolve(show === undefined ? { refused: 'Downloads shows no row for it.' } : { row: 'Downloads', show });
      }
      const show = rows()?.show({ kind: entry.kind, name: entry.name });
      if (show !== undefined) return Promise.resolve({ row: 'Mods', show });
      if (entry.kind === 'separator') return Promise.resolve({ refused: 'Mods shows no row for it.' });
      const path = rows()?.folderOf(entry.name);
      return Promise.resolve(path === undefined ? { refused: 'Mods shows no row for it and no folder holds it.' } : { shown: { kind: 'loose', path } });
    },
    referencesTo,
    referencedBy: (named) => showReferencedBy({
      reporter, subject: named.name, contextValue: `modbench.${named.kind}ReferencedBy`, references: () => referencesTo(named),
    }),
    tooltipOf(named) {
      const shown = entryListed(named);
      return Promise.resolve(tooltipLines(shown && tooltip(shown)));
    },
    /** Each of its kind, over the name so far. */
    async completionsAt(document, offset) {
      const found = await kind.nameAt(document, offset);
      if (found === undefined || 'refused' in found.symbol) return undefined;
      const { kind: named } = found.symbol;
      return { start: found.start, end: found.end, icon: SHOWN[named].completion, items: listed(named).map((label) => ({ label })) };
    },
    /** Each symbol whose name holds `query`, at its own file, else at its line in the owners' list, else at the first
     *  place a file names it. An entry no file names is left out. */
    async symbolsFor(query, gesture) {
      const matching = KINDS.flatMap((each) =>
        listed(each).filter((name) => nameHolds(name, query)).map((name): EntrySymbol => ({ kind: each, name })));
      const lists = await Promise.all(owners.map((owner) => owner.listed(heldTexts(unsavedTexts())).catch((error: unknown) => {
        reporter.shownOnSurface('warning', `${gesture} could not read an owner's list of mods and separators.`, errorMessage(error));
        return [];
      })));
      const lines = new Map<string, PlaceInFile>();
      for (const { entry, place } of lists.flat()) {
        const key = entryKey(entry);
        if (!lines.has(key)) lines.set(key, place);
      }
      const placeOf = async (entry: EntrySymbol): Promise<vscode.Location | undefined> => {
        const own = ownFile(entry);
        if (own !== undefined) return atFile(own);
        const line = lines.get(entryKey(entry));
        if (line !== undefined) return placeLocation(line);
        const { found, unread } = await read(entry);
        for (const why of unread) reporter.shownOnSurface('warning', `${gesture} on ${entry.name} could not read a file that may name it.`, why);
        return found[0] && placeLocation(found[0]);
      };
      const placed = await Promise.all(matching.map(async (entry): Promise<Listed | undefined> => {
        const location = await placeOf(entry);
        return location && {
          symbol: entry, name: entry.name, detail: NOUNS[entry.kind], icon: SHOWN[entry.kind].kind, location, resolve: selectingItsRow(() => kind.definitionOf(entry)),
        };
      }));
      return placed.filter((symbol) => symbol !== undefined);
    },
  };

  const renamableAt = async (document: AskedIn, offset: number) => {
    const found = await kind.nameAt(document, offset);
    return found && !('refused' in found.symbol) && isRenamable(found.symbol) ? { ...found, symbol: found.symbol } : undefined;
  };

  return {
    ...kind,
    /** The name of the mod or separator at `offset`, which Rename Symbol offers to rename; undefined where none is. */
    renameRangeAt: async (document: AskedIn, offset: number) => {
      const found = await renamableAt(document, offset);
      return found && { start: found.start, end: found.end, name: found.name };
    },
    /** Rename Symbol on the mod or separator whose name is at `offset`: its `rename` (symbols.md, The features, story 6);
     *  false where none is. */
    renameAt: async (document: AskedIn, offset: number, newName: string): Promise<boolean> => {
      const found = await renamableAt(document, offset);
      if (found === undefined) return false;
      const entry = entryListed(found.symbol);
      if (entry === undefined || !isRenamable(entry)) throw new Error(unlisted(found.symbol));
      await renameEntry(entry, newName);
      return true;
    },
  };
}
