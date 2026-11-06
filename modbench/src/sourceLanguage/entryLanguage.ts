import * as vscode from 'vscode';
import { referencesView } from '../drivingLib/referencesView';
import type { InstanceValue } from '../instanceLoader/instance';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { heldTexts, sameName, type EntryNames, type EntryReading, type EntrySymbol } from '../symbolNames/symbolNames';
import { heldText, unsavedTexts } from '../textDocuments/heldText';
import { reportedForFeature, reportedForGesture } from './pluginReferences';
import { placeLocation, referencedByInput, spelledAround, type AskedIn, type ListedLocations } from './symbolPlaces';

interface EntryLanguageDeps {
  instance: { readonly value: Pick<InstanceValue, 'mods'> } | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  owners: readonly EntryNames[];
  /** The mod's `go to`. */
  goTo: (mod: string) => Promise<void>;
  /** The tooltip of the entry's row; undefined where Mods shows none. */
  tooltip: (entry: EntrySymbol) => string | undefined;
}

const readBy = (owner: EntryNames, entry: EntrySymbol): Promise<EntryReading> =>
  owner.read(entry, heldTexts(unsavedTexts())).catch((error: unknown) => ({ references: [], leftOut: [errorMessage(error)] }));

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
    const readings = await Promise.all(owners.map((owner) => readBy(owner, entry)));
    return { found: readings.flatMap(({ references }) => references), unread: readings.flatMap(({ leftOut }) => leftOut) };
  };
  const located = (report: typeof reportedForGesture) => async (entry: EntrySymbol): Promise<ListedLocations> => {
    const { found, unread } = report(reporter, entry.name, await referencesTo(entry));
    return { locations: found.map(placeLocation), unread: unread.length };
  };
  const [locatedForGesture, locatedForFeature] = [located(reportedForGesture), located(reportedForFeature)];

  const nameWithSpan = async (document: AskedIn, offset: number) => {
    const text = heldText(document);
    for (const owner of owners) {
      const named = await owner.nameAt(document.uri.fsPath, text, offset);
      const span = named === undefined ? undefined : spelledAround(text, offset, named.name);
      if (named !== undefined && span !== undefined) return { named, ...span };
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
      return { start: found.start, end: found.end, lines: lines.length > 0 ? lines : [found.name] };
    },
    /** Completion where a file names a mod or a separator: each of its kind, over the name so far. */
    completionsAt: async (document: AskedIn, offset: number): Promise<{ start: number; end: number; items: string[] } | undefined> => {
      const found = await nameWithSpan(document, offset);
      return found && { start: found.start, end: found.end, items: listed(found.named.kind) };
    },
    /** Go to Symbol in Workspace: each mod and separator whose name holds `query`, at the first place a file names it. A
     *  name no file names has no place to be listed at. */
    symbolsFor: async (query: string): Promise<{ entry: EntrySymbol; location: vscode.Location }[]> => {
      const wanted = query.trim().toLowerCase();
      if (wanted === '') return [];
      const matching = (['mod', 'separator'] as const).flatMap((kind) =>
        listed(kind).filter((name) => name.toLowerCase().includes(wanted)).map((name): EntrySymbol => ({ kind, name })));
      const placed = await Promise.all(matching.map(async (entry) => {
        const [first] = (await locatedForFeature(entry)).locations;
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
