import type { ModlistNode, ModNode } from './ModListProvider';
import type { Instance } from '../instanceLoader/instance';
import { kindGuard, singularArgument, type GestureEntry } from '../drivingLib/gestureEntry';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { argumentOfKind } from '../drivingLib/agentGesture';
import type { EntryRef, OriginFileRef } from '../modCommands/modCommands';
import type { Argument } from '../wire/argument';

/** The `args` a Mods key passes, so a command other surfaces share knows the key is the Mods
 *  view's. */
export const MODS_KEY_ARGS = { view: 'modbench.modList' } as const;

export const runModsWriting = <T>(instance: Pick<Instance, 'refresh'>, command: () => Promise<T>): Promise<T> =>
  runWritingGesture(MODS_KEY_ARGS.view, instance, command);

export const modNameOf = (argument: Argument): string => argumentOfKind(argument, 'mod').name;

export const separatorNameOf = (argument: Argument): string => argumentOfKind(argument, 'separator').name;

export const entryRefOf = (argument: Argument): EntryRef => {
  const { kind, name } = argumentOfKind(argument, 'mod', 'separator');
  return { kind, name };
};

export const fileRefOf = (argument: Argument): OriginFileRef => {
  const { origin, relativePath } = argumentOfKind(argument, 'file');
  return { origin, relativePath };
};

const isRowOf = kindGuard<ModlistNode>();

const OPEN_FOLDER_KINDS = ['mod', 'runtimeOutput', 'folder', 'file'] as const;

export const openFolderArgument = (entry: GestureEntry<ModlistNode>) => singularArgument(entry, ...OPEN_FOLDER_KINDS);

interface ModsKeyContext {
  readonly selectionToggle?: 'enable' | 'disable';
  readonly selectionKind?: ModlistNode['kind'];
  readonly singleRow: boolean;
  /** One row, and open folder takes it. */
  readonly singleOpenFolderRow: boolean;
  /** One row, and a mod with a repository. */
  readonly singleOpenSourceRow: boolean;
  /** One row, and a file in a file order conflict. */
  readonly singleGoToModRow: boolean;
  /** One row, and a file that loses its file order conflict. */
  readonly singleCompareFileRow: boolean;
  readonly holdsEnabledMod: boolean;
  readonly holdsDisabledMod: boolean;
  readonly holdsNonSourceModWithPlugin: boolean;
  readonly holdsIncludedFile: boolean;
  readonly holdsExcludedFile: boolean;
}

export function modsKeyContext(selection: readonly ModlistNode[], isEnabled: (row: ModNode) => boolean): ModsKeyContext {
  const mods = selection.filter(isRowOf(['mod']));
  const files = selection.filter(isRowOf(['file']));
  // No API names the focused row, and a file or folder in the selection may be it: the keys do
  // nothing on one (common.md, A view, story 5).
  const keyed = selection.some(isRowOf(['folder', 'file'])) ? [] : selection;
  const [firstMod] = keyed.filter(isRowOf(['mod']));
  const kinds = new Set(keyed.filter(isRowOf(['mod', 'separator'])).map((row) => row.kind));
  const [onlyKind] = kinds;
  const [onlyRow] = selection.length === 1 ? selection : [];
  return {
    selectionToggle: firstMod && toggleOf(isEnabled(firstMod)),
    selectionKind: kinds.size === 1 ? onlyKind : undefined,
    singleRow: onlyRow !== undefined,
    singleOpenFolderRow: openFolderArgument({ focused: onlyRow, selection }) !== undefined,
    singleOpenSourceRow: onlyRow?.kind === 'mod' && onlyRow.facts?.sourceMod === true,
    singleGoToModRow: onlyRow?.kind === 'file' && onlyRow.conflict !== 'none',
    singleCompareFileRow: onlyRow?.kind === 'file' && onlyRow.conflict === 'loses',
    holdsEnabledMod: mods.some(isEnabled),
    holdsDisabledMod: mods.some((row) => !isEnabled(row)),
    holdsNonSourceModWithPlugin: mods.some((row) => row.facts?.holdsPlugin === true && !row.facts.sourceMod),
    holdsIncludedFile: files.some((row) => row.exclusion === 'included'),
    holdsExcludedFile: files.some((row) => row.exclusion === 'excluded'),
  };
}

function toggleOf(enabled: boolean): 'enable' | 'disable' {
  return enabled ? 'disable' : 'enable';
}
