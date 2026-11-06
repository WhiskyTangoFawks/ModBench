// What another program's rename of a file or folder of MO2's renames: a plugin at an origin's root, or an entry's folder.

import { basename, dirname } from 'node:path';
import { samePath } from '../../symbolNames/symbolNames';
import { isPluginFile } from '../../tables/pluginFile';
import { OVERWRITE_ORIGIN } from '../../wire/pluginAddress';
import { ignoreSkippedLink } from '../files';
import type { InstanceAdapter } from '../instanceAdapter';
import { entryNamed } from './codecs/modlistText';
import { overwriteDir } from './layout';
import { listModFolders, type Mo2Context } from './mo2Context';

export function mo2RenamedSymbol(context: Mo2Context): Pick<InstanceAdapter, 'renamedSymbol'> {
  return {
    async renamedSymbol(from, to) {
      const folder = dirname(from);
      if (!samePath(folder, dirname(to))) return undefined;
      const folders = await listModFolders(context, ignoreSkippedLink) ?? [];
      const entry = folders.find(({ path }) => samePath(path, from));
      if (entry !== undefined) return { kind: 'entry', entry: { kind: entry.kind, name: entry.name }, to: entryNamed(basename(to)) };
      if (!isPluginFile(from)) return undefined;
      const origin = samePath(folder, overwriteDir(context.instanceRoot))
        ? OVERWRITE_ORIGIN
        : folders.find(({ kind, path }) => kind === 'mod' && samePath(path, folder))?.name;
      return origin === undefined ? undefined : { kind: 'plugin', plugin: { name: basename(from), origin }, to: basename(to) };
    },
  };
}
