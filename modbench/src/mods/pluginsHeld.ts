import type { InstanceValue, OriginFile } from '../instanceLoader/instance';
import { pluginNameKey, type PluginAddress } from '../wire/pluginAddress';
import { ModNode, OverwriteNode, SeparatorNode } from './ModListProvider';

type HeldIn = Pick<InstanceValue, 'modGroups' | 'filesByMod' | 'overwriteFiles' | 'plugins' | 'mods'>;

const rootNames = (files: readonly OriginFile[]): string[] =>
  files.map((file) => file.relativePath).filter((relativePath) => !relativePath.includes('/'));

/** The plugin rows the selected Mods rows hold (plugins.md, The highlight, stories 1, 2 and 6):
 *  each plugin a mod's files hold, matched by name to the row the game loads. */
export function pluginsHeld(value: HeldIn, selection: readonly unknown[]): PluginAddress[] {
  const enabled = new Set(value.mods.flatMap((entry) => (entry.kind === 'mod' && entry.enabled ? [entry.name] : [])));
  const names = new Set<string>();
  const hold = (files: readonly OriginFile[]) => { for (const name of rootNames(files)) names.add(pluginNameKey(name)); };
  const holdMod = (name: string) => { if (enabled.has(name)) hold(value.filesByMod.get(name) ?? []); };
  for (const row of selection) {
    if (row instanceof ModNode) holdMod(row.mod.name);
    else if (row instanceof OverwriteNode) hold(value.overwriteFiles);
    else if (row instanceof SeparatorNode) {
      for (const mod of value.modGroups.groups.find((group) => group.separator.name === row.separator.name)?.mods ?? []) holdMod(mod.name);
    }
  }
  return value.plugins.filter((plugin) => plugin.winning && names.has(pluginNameKey(plugin.name))).map(({ name, origin }) => ({ name, origin }));
}
