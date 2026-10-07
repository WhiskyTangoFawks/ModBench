import { OVERWRITE_ORIGIN } from '../instanceLoader/loadOrderSnapshot';
import type { ModlistNode, ModNode } from './ModListProvider';
import type { Instance } from '../instanceLoader/instance';
import { kindGuard, singularArgument, type GestureEntry } from '../drivingLib/gestureEntry';
import { runWritingGesture } from '../drivingLib/writingGesture';

/** The `args` a Mods key passes, so a command other surfaces share knows the key is the Mods
 *  view's. */
export const MODS_KEY_ARGS = { view: 'modbench.modList' } as const;

export const runModsWriting = (instance: Pick<Instance, 'refresh'>, command: () => Promise<void>): Promise<void> =>
  runWritingGesture(MODS_KEY_ARGS.view, instance, command);

export const isRowOf = kindGuard<ModlistNode>();

const OPEN_FOLDER_KINDS = ['mod', OVERWRITE_ORIGIN, 'folder', 'file'] as const;

export const openFolderArgument = (entry: GestureEntry<ModlistNode>) => singularArgument(entry, ...OPEN_FOLDER_KINDS);

/** What the Mods keys' and palette entries' `when` clauses read off the selection, since neither
 *  is handed a row. */
export interface ModsKeyContext {
  readonly selectionToggle?: 'enable' | 'disable';
  readonly selectionKind?: ModlistNode['kind'];
  readonly singleRow: boolean;
  /** One row, and open folder takes it. */
  readonly singleOpenFolderRow: boolean;
  /** One row, and a file in a file order conflict. */
  readonly singleGoToModRow: boolean;
  /** One row, and a file that loses its file order conflict. */
  readonly singleCompareFileRow: boolean;
  /** One row, and a mod with a file order conflict. */
  readonly singleOpenConflictsRow: boolean;
  readonly holdsEnabledMod: boolean;
  readonly holdsDisabledMod: boolean;
  readonly holdsUntrackedModWithPlugin: boolean;
  readonly holdsIncludedFile: boolean;
  readonly holdsExcludedFile: boolean;
}

export function modsKeyContext(selection: readonly ModlistNode[], isEnabled: (row: ModNode) => boolean): ModsKeyContext {
  const mods = selection.filter(isRowOf(['mod']));
  const files = selection.filter(isRowOf(['file']));
  // No API names the focused row, and a file or folder in the selection may be it: the keys do
  // nothing on one (mods.md, Menus and keys, story 8).
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
    singleGoToModRow: onlyRow?.kind === 'file' && onlyRow.conflict !== 'none',
    singleCompareFileRow: onlyRow?.kind === 'file' && onlyRow.conflict === 'loses',
    singleOpenConflictsRow: onlyRow?.kind === 'mod' && onlyRow.facts?.fileOrderConflict === true,
    holdsEnabledMod: mods.some(isEnabled),
    holdsDisabledMod: mods.some((row) => !isEnabled(row)),
    holdsUntrackedModWithPlugin: mods.some((row) => row.facts?.holdsPlugin === true && !row.facts.tracked),
    holdsIncludedFile: files.some((row) => row.exclusion === 'included'),
    holdsExcludedFile: files.some((row) => row.exclusion === 'excluded'),
  };
}

function toggleOf(enabled: boolean): 'enable' | 'disable' {
  return enabled ? 'disable' : 'enable';
}
