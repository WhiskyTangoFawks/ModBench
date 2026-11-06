import * as vscode from 'vscode';
import { referencesView } from '../drivingLib/referencesView';
import type { InstanceValue } from '../instanceLoader/instance';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { heldTexts, sameName, type EntryNames, type EntrySymbol, type PlaceInFile } from '../symbolNames/symbolNames';
import { heldText, unsavedTexts } from '../textDocuments/heldText';
import { placeLocation, readBy, referencedByInput, reportedForFeature, reportedForGesture, type AskedIn, type ListedLocations } from './symbolPlaces';

interface EntryLanguageDeps {
  instance: { readonly value: Pick<InstanceValue, 'mods' | 'downloadedFiles' | 'profiles'> } | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  owners: readonly EntryNames[];
  /** The mod's `go to`. */
  goTo: (mod: string) => Promise<void>;
  /** The tooltip of the row Mods shows for a mod or a separator; undefined where it shows none. */
  entryTooltip: (entry: EntrySymbol & { readonly kind: 'mod' | 'separator' }) => string | undefined;
  /** The tooltip of the row Downloads shows for a downloaded file; undefined where it shows none. */
  downloadedFileTooltip: (name: string) => string | undefined;
}

const entryKey = ({ kind, name }: EntrySymbol): string => `${kind}:${name.toLowerCase()}`;

const KINDS = ['mod', 'separator', 'downloadedFile', 'profile'] as const;

const unlisted = ({ kind, name }: EntrySymbol): string => ({
  mod: `Mods lists no mod named ${name}.`,
  separator: `Mods lists no separator named ${name}.`,
  downloadedFile: `Downloads lists no downloaded file named ${name}.`,
  profile: `The instance holds no profile named ${name}.`,
})[kind];

/** A mod, a separator, a downloaded file and a profile as symbols in the text editor: wherever an owner's file names
 *  them, and the places files name them (symbols.md). */
export function entryLanguage({ instance, reporter, owners, goTo, entryTooltip, downloadedFileTooltip }: EntryLanguageDeps) {
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
  const entryListed = ({ kind, name }: EntrySymbol): EntrySymbol | undefined => {
    const found = listed(kind).find((each) => sameName(each, name));
    return found === undefined ? undefined : { kind, name: found };
  };

  const referencesTo = async (entry: EntrySymbol) => {
    const readings = await Promise.all(owners.map((owner) => readBy(owner, entry, heldTexts(unsavedTexts()))));
    return { found: readings.flatMap(({ references }) => references), unread: readings.flatMap(({ leftOut }) => leftOut) };
  };
  const located = (report: typeof reportedForGesture) => async (entry: EntrySymbol): Promise<ListedLocations> => {
    const { found, unread } = report(reporter, entry.name, await referencesTo(entry));
    return { locations: found.map(placeLocation), unread: unread.length };
  };
  const [locatedForGesture, locatedForFeature] = [located(reportedForGesture), located(reportedForFeature)];

  const nameWithSpan = async (document: AskedIn, offset: number) => {
    for (const owner of owners) {
      const found = await owner.nameAt(document.uri.fsPath, heldText(document), offset);
      if (found !== undefined) return { named: found.entry, start: found.start, end: found.end };
    }
    return undefined;
  };

  return {
    /** Go to Definition on the mod whose name is at `offset`: the mod's `go to`. A separator has none. Undefined where
     *  no mod's name is. */
    definitionAt: async (document: AskedIn, offset: number): Promise<{ start: number; end: number; resolved: boolean } | undefined> => {
      const found = await nameWithSpan(document, offset);
      if (found?.named.kind !== 'mod') return undefined;
      const mod = entryListed(found.named);
      if (mod === undefined) reporter.shownOnSurface('warning', `Go to Definition cannot go to ${found.named.name}.`, unlisted(found.named));
      else await goTo(mod.name);
      return { start: found.start, end: found.end, resolved: mod !== undefined };
    },
    /** What a hover on the name at `offset` says: its row's tooltip, or its name when Mods shows none. */
    hoverAt: async (document: AskedIn, offset: number): Promise<{ start: number; end: number; lines: readonly string[] } | undefined> => {
      const found = await nameWithSpan(document, offset);
      if (found === undefined) return undefined;
      const shown = entryListed(found.named);
      const lines = (shown && tooltip(shown))?.split('\n').filter((line) => line !== '') ?? [];
      return { start: found.start, end: found.end, lines: lines.length > 0 ? lines : [found.named.name] };
    },
    /** Completion where a file names a symbol: each of its kind, over the name so far. */
    completionsAt: async (document: AskedIn, offset: number): Promise<{ start: number; end: number; kind: EntrySymbol['kind']; items: readonly string[] } | undefined> => {
      const found = await nameWithSpan(document, offset);
      return found && { start: found.start, end: found.end, kind: found.named.kind, items: listed(found.named.kind) };
    },
    /** Go to Symbol in Workspace: each symbol whose name holds `query`, at the first place the owners list it, else at the
     *  first place a file names it. A symbol no file names is left out. */
    symbolsFor: async (query: string): Promise<{ entry: EntrySymbol; location: vscode.Location }[]> => {
      const wanted = query.trim().toLowerCase();
      if (wanted === '') return [];
      const matching = KINDS.flatMap((kind) =>
        listed(kind).filter((name) => name.toLowerCase().includes(wanted)).map((name): EntrySymbol => ({ kind, name })));
      const kinds = KINDS.filter((kind) => matching.some((entry) => entry.kind === kind));
      const lists = await Promise.all(kinds.flatMap((kind) => owners.map((owner) => owner.listed(kind, heldTexts(unsavedTexts())).catch((error: unknown) => {
        reporter.shownOnSurface('warning', 'Go to Symbol in Workspace could not read where an owner\'s files name its symbols.', errorMessage(error));
        return [];
      }))));
      const lines = new Map<string, PlaceInFile>();
      for (const { entry, place } of lists.flat()) {
        const key = entryKey(entry);
        if (!lines.has(key)) lines.set(key, place);
      }
      const placed = await Promise.all(matching.map(async (entry) => {
        const line = lines.get(entryKey(entry));
        const [first] = line === undefined ? (await locatedForFeature(entry)).locations : [placeLocation(line)];
        return first && { entry, location: first };
      }));
      return placed.filter((symbol) => symbol !== undefined);
    },
    /** Find All References on the symbol whose name is at `offset`; undefined where no such symbol's name is. */
    referencesAt: async (document: AskedIn, offset: number): Promise<vscode.Location[] | undefined> => {
      const found = await nameWithSpan(document, offset);
      if (found === undefined) return undefined;
      const entry = entryListed(found.named);
      if (entry !== undefined) return (await locatedForFeature(entry)).locations;
      reporter.shownOnSurface('warning', `Find All References cannot list what names ${found.named.name}.`, unlisted(found.named));
      return [];
    },
    /** Lists each place a file names `mod`, in VS Code's References view, anchored at the first. */
    referencedBy: async (mod: string): Promise<void> => {
      const view = await referencesView();
      if (!view) return;
      const entry = { kind: 'mod', name: mod } as const;
      const first = await locatedForGesture(entry);
      const [anchor] = first.locations;
      if (anchor === undefined) {
        reporter.report('error', `Could not list where files name ${mod}.`, 'No file names it.');
        return;
      }
      view.setInput(referencedByInput(`Referenced By: ${mod}`, 'modbench.modReferencedBy', anchor, () => locatedForGesture(entry), first));
    },
  };
}
