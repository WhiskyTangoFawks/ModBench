import { kindGuard } from '../drivingLib/gestureEntry';
import type { Argument } from '../wire/argument';
import type { PluginAddress } from '../wire/pluginAddress';
import type { PluginsTreeNode } from './pluginRows';

/** The `args` a Plugins key passes, so a command other surfaces share knows the key is the
 *  Plugins view's. */
export const PLUGINS_KEY_ARGS = { view: 'modbench.pluginListTree' } as const;

/** The agent box hands a plugin gesture plugins only. */
export function pluginOf(argument: Argument): PluginAddress {
  if (argument.kind !== 'plugin') throw new Error(`An agent call to a plugin gesture carries plugins only, and this one carries a ${argument.kind}.`);
  return argument.plugin;
}

type ArgumentKind = PluginsTreeNode['kind'];
type RowOf<K extends ArgumentKind> = Extract<PluginsTreeNode, { kind: K }>;

const isOf = kindGuard<PluginsTreeNode>();

/** The rows that stand for a record: the record menu's rows (plugins.md, Menus and keys). */
export const RECORD_ROW_KINDS = ['record', 'worldspace', 'cell', 'placed'] as const;

export const isRecordRow = isOf(RECORD_ROW_KINDS);

/** The rows that stand for a plugin file: a plugins.txt line, or a plugin the game loads with
 *  none. */
export const PLUGIN_ROW_KINDS = ['plugin', 'implicitMaster'] as const;

/** The one selected row, when it is of `kind`: a singular gesture's Argument from the palette. */
export function onlySelected<K extends ArgumentKind>(selection: readonly PluginsTreeNode[], ...kinds: K[]): RowOf<K> | undefined {
  const [only, ...rest] = selection;
  return rest.length === 0 && only !== undefined && isOf(kinds)(only) ? only : undefined;
}

const hasFlags = (row: PluginsTreeNode | undefined, ...flags: string[]): boolean => {
  const own = new Set((row?.contextValue ?? '').split(' '));
  return flags.every((flag) => own.has(flag));
};

/** The rows create record is offered on (plugins.md, Menus and keys). */
export const CREATE_ROW_KINDS = ['plugin', 'recordType', 'record', 'worldspace', 'cell'] as const;

export const isContainerRow = (row: PluginsTreeNode): boolean => hasFlags(row, 'container');

// A palette gesture sends no item it would refuse, so it needs every selected row to qualify.
const every = (selection: readonly PluginsTreeNode[], qualifies: (row: PluginsTreeNode) => boolean): boolean =>
  selection.length > 0 && selection.every(qualifies);

/** What the Plugins palette entries' and keys' `when` clauses read off the selection, since
 *  neither is handed a row. */
export interface PluginsKeyContext {
  readonly singlePlugin: boolean;
  readonly holdsPluginLine: boolean;
  readonly holdsEnabledPlugin: boolean;
  readonly holdsDisabledPlugin: boolean;
  readonly allInUntrackedMod: boolean;
  readonly allInTrackedMod: boolean;
  readonly singleCreatable: boolean;
  readonly singleTracked: boolean;
  readonly allDeletableRecords: boolean;
  readonly allRecords: boolean;
  readonly selectionToggle?: 'enable' | 'disable';
}

/** `isEnabled` reads the plugin's line as it is now, not as the row was built. */
export function pluginsKeyContext(
  selection: readonly PluginsTreeNode[], isEnabled: (row: RowOf<'plugin'>) => boolean,
): PluginsKeyContext {
  const plugins = selection.filter(isOf(['plugin']));
  const [firstPlugin] = plugins;
  const creatableCandidate = onlySelected(selection, ...CREATE_ROW_KINDS);
  return {
    singlePlugin: onlySelected(selection, ...PLUGIN_ROW_KINDS) !== undefined,
    holdsPluginLine: firstPlugin !== undefined,
    holdsEnabledPlugin: plugins.some(isEnabled),
    holdsDisabledPlugin: plugins.some((row) => !isEnabled(row)),
    allInUntrackedMod: every(selection, (row) => row.kind === 'plugin' && hasFlags(row, 'inUntrackedMod')),
    allInTrackedMod: every(selection, (row) => row.kind === 'plugin' && hasFlags(row, 'inTrackedMod')),
    // A plugin row carries no creatable fact and needs none: its own pick lists only creatable
    // types (plugins.md, Create record, story 1; "No dead entries").
    singleCreatable: creatableCandidate !== undefined
      && hasFlags(creatableCandidate, 'tracked', 'editable')
      && (creatableCandidate.kind === 'plugin' || hasFlags(creatableCandidate, 'creatable') || isContainerRow(creatableCandidate)),
    singleTracked: hasFlags(onlySelected(selection, 'plugin'), 'tracked'),
    allDeletableRecords: every(selection, (row) => isOf(RECORD_ROW_KINDS)(row) && hasFlags(row, 'tracked', 'editable')),
    allRecords: every(selection, isOf(RECORD_ROW_KINDS)),
    selectionToggle: firstPlugin && (isEnabled(firstPlugin) ? 'disable' : 'enable'),
  };
}
