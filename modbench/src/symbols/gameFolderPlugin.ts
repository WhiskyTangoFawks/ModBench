import type { PluginSymbol } from '../symbolNames/symbolNames';
import { DATA_DIRECTORY_ORIGIN } from '../wire/pluginAddress';

export function refuseGameFolderPlugin({ name, origin }: PluginSymbol): void {
  if (origin === DATA_DIRECTORY_ORIGIN) throw new Error(`${name} is a plugin in the game folder, not in a mod: only a plugin in a mod renames.`);
}
