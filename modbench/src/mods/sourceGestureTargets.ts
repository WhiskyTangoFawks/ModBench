import type { PluginAddress } from '../client';
import { modArgumentOf, pluginArgumentOf, rowNameOf } from '../drivingLib/argument';
import { columnHeaderOf } from '../wire/columnHeader';
import { argumentOfKind } from '../drivingLib/agentGesture';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { Argument } from '../wire/argument';
import { MODS_KEY_ARGS } from './gestureEntry';

// ADR-0012.
export function rowName(row: PluginAddress): string {
  return `${row.name} (${row.origin})`;
}

export interface ModTargets {
  mods: readonly string[];
  /** Rows named with why they were not sent: a plugin no mod provides, such as Overwrite's or the game's own, or a row that carries no mod or plugin. */
  refusedRows: readonly ItemRefusal<string>[];
}

const NOT_IN_A_MOD = 'it is not in a mod';
const NO_MOD_OR_PLUGIN = 'it carries no mod or plugin';

export interface ModsGiven {
  readonly mods: readonly string[];
  /** What a view call was given that names no mod to send, and why. */
  readonly refusedRows: readonly ItemRefusal<string>[];
  readonly invokedFrom: string;
}

export const givenByAgent = (argument: readonly Argument[]): ModsGiven =>
  ({ mods: argument.map((mod) => argumentOfKind(mod, 'mod').name), refusedRows: [], invokedFrom: MODS_KEY_ARGS.view });

/** A gesture from a Mods row runs under the Mods view's bar, and one from a plugin row under the Plugins view's. */
export const viewOf = (rows: readonly unknown[], pluginsView: string): string =>
  (rows.some((row) => modArgumentOf(row) !== undefined) ? MODS_KEY_ARGS.view : pluginsView);

export function targetsOf(rows: readonly unknown[], modOfOrigin: (origin: string) => string | undefined): ModTargets {
  const mods = new Set<string>();
  const refusedRows: ItemRefusal<string>[] = [];
  for (const row of rows) {
    const mod = modArgumentOf(row);
    if (mod !== undefined) { mods.add(mod.name); continue; }
    const plugin = pluginAddressOf(row);
    if (plugin === undefined) { refusedRows.push({ item: rowNameOf(row), reason: NO_MOD_OR_PLUGIN }); continue; }
    const owner = modOfOrigin(plugin.origin);
    if (owner === undefined) refusedRows.push({ item: rowName(plugin), reason: NOT_IN_A_MOD }); else mods.add(owner);
  }
  return { mods: [...mods], refusedRows };
}

// A plugin row or a column header acts on its plugin's mod.
function pluginAddressOf(row: unknown): PluginAddress | undefined {
  return pluginArgumentOf(row)?.plugin ?? columnHeaderOf(row);
}
