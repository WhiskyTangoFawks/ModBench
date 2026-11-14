import type { MEditClient, PluginAddress, PluginFilePaths } from '../client';
import { bounded, REQUESTS_AT_ONCE } from '../ports/bounded';
import { pluginAddressKey } from '../wire/pluginAddress';
import { isReadFailed } from '../wire/readFailed';

type Answer = PluginFilePaths[] | Awaited<ReturnType<MEditClient['getPluginFilePaths']>>;
type Asked = Pick<MEditClient, 'getPluginFilePaths' | 'getPluginProblems'>;

const WHOLE_SET = '';

/** The one asker of the Problems panel's feeds: a plugin's file paths are asked once until a notification names the
 *  plugin or the load order settles, and a failed answer is held by no one. */
export function problemsAsker(client: Asked & Pick<MEditClient, 'onNotification' | 'onLoadOrderSettled'>): Asked {
  const inTurn = bounded(REQUESTS_AT_ONCE);
  let paths = new Map<string, Promise<Answer>>();

  const named = ({ plugin }: { plugin: PluginAddress }) => {
    paths.delete(WHOLE_SET);
    paths.delete(pluginAddressKey(plugin));
  };
  client.onNotification('rows-changed', named);
  client.onNotification('plugin-changed', named);
  client.onLoadOrderSettled(() => { paths = new Map(); });

  const filePathsOf = (plugin?: PluginAddress): Promise<Answer> => {
    const key = plugin === undefined ? WHOLE_SET : pluginAddressKey(plugin);
    const held = paths.get(key);
    if (held) return held;
    const whole = paths.get(WHOLE_SET);
    if (plugin !== undefined && whole) return whole.then((answer) => (isReadFailed(answer) ? answer : answer.filter((each) => pluginAddressKey(each.plugin) === key)));
    const asked = inTurn(() => client.getPluginFilePaths(plugin));
    paths.set(key, asked);
    const forget = (answer?: Answer) => { if ((answer === undefined || isReadFailed(answer)) && paths.get(key) === asked) paths.delete(key); };
    asked.then(forget, () => { forget(); });
    return asked;
  };

  return {
    getPluginFilePaths: filePathsOf,
    getPluginProblems: (plugin) => inTurn(() => client.getPluginProblems(plugin)),
  };
}
