import { isReadFailed, type ReadFailed } from '../wire/readFailed';
import type { DocumentName, MEditClient } from './MEditClient';

type Ask = Pick<MEditClient, 'getPluginSourceNames'>;

/** The record index's names for plugin source, asked only of a file `isPluginSource` says is plugin source, and once
 *  for a place every kind asks of in turn, until the record index changes. */
export function pluginSourceNames(client: Ask & Pick<MEditClient, 'onNotification'>, isPluginSource: (path: string) => boolean): Ask {
  let last: { text: string; path?: string; at?: number; names: Promise<DocumentName[] | ReadFailed> } | undefined;
  const forget = () => { last = undefined; };
  client.onNotification('rows-changed', forget);
  client.onNotification('plugin-changed', forget);
  return {
    getPluginSourceNames(text, path, at) {
      if (path !== undefined && !isPluginSource(path)) return Promise.resolve([]);
      if (last?.text === text && last.path === path && last.at === at) return last.names;
      const names = client.getPluginSourceNames(text, path, at);
      const asked = { text, path, at, names };
      last = asked;
      void names.then((answer) => { if (isReadFailed(answer) && last === asked) forget(); });
      return names;
    },
  };
}
