import * as vscode from 'vscode';
import { referencesView } from '../drivingLib/referencesView';
import type { InstanceValue } from '../instanceLoader/instance';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { heldTexts, sameName, type EntryNames, type EntrySymbol, type PlaceInFile } from '../symbolNames/symbolNames';
import { heldText, unsavedTexts } from '../textDocuments/heldText';
import { placeLocation, readBy, referencedByInput, reportedForFeature, reportedForGesture, type AskedIn, type ListedLocations } from './symbolPlaces';

interface EntryLanguageDeps {
  instance: { readonly value: Pick<InstanceValue, 'mods'> } | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  owners: readonly EntryNames[];
  /** The mod's `go to`. */
  goTo: (mod: string) => Promise<void>;
  /** The tooltip of the entry's row; undefined where Mods shows none. */
  tooltip: (entry: EntrySymbol) => string | undefined;
}

const entryKey = ({ kind, name }: EntrySymbol): string => `${kind}:${name.toLowerCase()}`;

/** A mod and a separator as symbols in the text editor: wherever an owner's file names them, and the places files name
 *  them (symbols.md). */
export function entryLanguage({ instance, reporter, owners, goTo, tooltip }: EntryLanguageDeps) {
  const listed = (kind: EntrySymbol['kind']): string[] =>
    (instance?.value.mods ?? []).flatMap((entry) => (entry.kind === kind ? [entry.name] : []));
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

  const unlisted = (named: EntrySymbol): string => `Mods lists no ${named.kind} named ${named.name}.`;

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
    /** Completion where a file names a mod or a separator: each of its kind, over the name so far. */
    completionsAt: async (document: AskedIn, offset: number): Promise<{ start: number; end: number; items: string[] } | undefined> => {
      const found = await nameWithSpan(document, offset);
      return found && { start: found.start, end: found.end, items: listed(found.named.kind) };
    },
    /** Go to Symbol in Workspace: each entry whose name holds `query`, at its line in the owners' list, else at the first
     *  place a file names it. An entry no file names is left out. */
    symbolsFor: async (query: string): Promise<{ entry: EntrySymbol; location: vscode.Location }[]> => {
      const wanted = query.trim().toLowerCase();
      if (wanted === '') return [];
      const matching = (['mod', 'separator'] as const).flatMap((kind) =>
        listed(kind).filter((name) => name.toLowerCase().includes(wanted)).map((name): EntrySymbol => ({ kind, name })));
      const lists = await Promise.all(owners.map((owner) => owner.listed(heldTexts(unsavedTexts())).catch((error: unknown) => {
        reporter.shownOnSurface('warning', 'Go to Symbol in Workspace could not read an owner\'s list of mods and separators.', errorMessage(error));
        return [];
      })));
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
    /** Find All References on the mod or separator whose name is at `offset`; undefined where no entry's name is. */
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
