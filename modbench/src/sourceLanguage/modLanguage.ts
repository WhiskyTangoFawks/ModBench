import * as vscode from 'vscode';
import { referencesView } from '../drivingLib/referencesView';
import type { InstanceValue } from '../instanceLoader/instance';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { heldTexts, sameName, type ModNames, type ModReading } from '../symbolNames/symbolNames';
import { heldText, unsavedTexts } from '../textDocuments/heldText';
import { reportedForFeature, reportedForGesture } from './pluginReferences';
import { placeLocation, referencedByInput, spelledAround, type AskedIn, type ListedLocations } from './symbolPlaces';

interface ModLanguageDeps {
  instance: { readonly value: Pick<InstanceValue, 'mods'> } | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  owners: readonly ModNames[];
  /** The mod's `go to`. */
  goTo: (mod: string) => Promise<void>;
}

const readBy = (owner: ModNames, mod: string): Promise<ModReading> =>
  owner.read(mod, heldTexts(unsavedTexts())).catch((error: unknown) => ({ references: [], leftOut: [errorMessage(error)] }));

/** A mod as a symbol in the text editor: wherever an owner's file names it, and the places files name it (symbols.md). */
export function modLanguage({ instance, reporter, owners, goTo }: ModLanguageDeps) {
  const modNamed = (name: string): string | undefined =>
    instance?.value.mods.find((entry) => entry.kind === 'mod' && sameName(entry.name, name))?.name;

  const referencesTo = async (mod: string) => {
    const readings = await Promise.all(owners.map((owner) => readBy(owner, mod)));
    return { found: readings.flatMap(({ references }) => references), unread: readings.flatMap(({ leftOut }) => leftOut) };
  };
  const listed = (report: typeof reportedForGesture) => async (mod: string): Promise<ListedLocations> => {
    const { found, unread } = report(reporter, mod, await referencesTo(mod));
    return { locations: found.map(placeLocation), unread: unread.length };
  };
  const [listedForGesture, listedForFeature] = [listed(reportedForGesture), listed(reportedForFeature)];

  const nameWithSpan = async (document: AskedIn, offset: number) => {
    const text = heldText(document);
    for (const owner of owners) {
      const named = await owner.nameAt(document.uri.fsPath, text, offset);
      const span = named === undefined ? undefined : spelledAround(text, offset, named);
      if (named !== undefined && span !== undefined) return { named, ...span };
    }
    return undefined;
  };

  return {
    /** Go to Definition on the mod whose name is at `offset`: the mod's `go to`. Undefined where no mod's name is. */
    definitionAt: async (document: AskedIn, offset: number): Promise<{ start: number; end: number; resolved: boolean } | undefined> => {
      const found = await nameWithSpan(document, offset);
      if (found === undefined) return undefined;
      const mod = modNamed(found.named);
      if (mod === undefined) reporter.shownOnSurface('warning', `Go to Definition cannot go to ${found.named}.`, `Mods lists no mod named ${found.named}.`);
      else await goTo(mod);
      return { start: found.start, end: found.end, resolved: mod !== undefined };
    },
    /** Find All References on the mod whose name is at `offset`; undefined where no mod's name is. */
    referencesAt: async (document: AskedIn, offset: number): Promise<vscode.Location[] | undefined> => {
      const found = await nameWithSpan(document, offset);
      if (found === undefined) return undefined;
      const mod = modNamed(found.named);
      if (mod !== undefined) return (await listedForFeature(mod)).locations;
      reporter.shownOnSurface('warning', `Find All References cannot list what names ${found.named}.`, `Mods lists no mod named ${found.named}.`);
      return [];
    },
    /** Lists each place a file names `mod`, in VS Code's References view, anchored at the first. */
    referencedBy: async (mod: string): Promise<void> => {
      const view = await referencesView();
      if (!view) return;
      const first = await listedForGesture(mod);
      const [anchor] = first.locations;
      if (anchor === undefined) {
        reporter.report('error', `Could not list where files name ${mod}.`, 'No file names it.');
        return;
      }
      view.setInput(referencedByInput(`Referenced By: ${mod}`, 'modbench.modReferencedBy', anchor, () => listedForGesture(mod), first));
    },
  };
}
