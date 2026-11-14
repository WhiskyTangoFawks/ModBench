import { bounded, REQUESTS_AT_ONCE, type InTurn } from '../ports/bounded';
import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';
import { isReadFailed, type ReadFailed } from '../wire/readFailed';

interface Answered { plugin: PluginAddress; failure?: string | null; unread: string[] }

interface Reads<Paths extends Answered, Problems, Status> {
  getPluginFilePaths(plugin?: PluginAddress): Promise<Paths[] | ReadFailed>;
  getPluginProblems(plugin?: PluginAddress): Promise<Problems[] | ReadFailed>;
  onNotification(kind: 'rows-changed' | 'plugin-changed', listener: (event: { plugin: PluginAddress }) => void): () => void;
  onLoadOrderSettled(listener: (status: Status) => void): () => void;
}

export interface ProblemsAsker<Paths extends Answered, Problems, Status> {
  getPluginFilePaths: Reads<Paths, Problems, Status>['getPluginFilePaths'];
  getPluginProblems: Reads<Paths, Problems, Status>['getPluginProblems'];
  /** Told after the asker dropped what it held of the plugin. */
  onPluginChanged(listener: (event: { plugin: PluginAddress }) => void): () => void;
  /** Told after the asker dropped everything it held. */
  onLoadOrderSettled(listener: (status: Status) => void): () => void;
  /** Drops what it held of the plugin, or of all. */
  forget(plugin?: PluginAddress): void;
  inTurn: InTurn;
}

const WHOLE_SET = '';
const keyOf = (plugin?: PluginAddress): string => plugin === undefined ? WHOLE_SET : pluginAddressKey(plugin);

export function problemsAsker<Paths extends Answered, Problems, Status>(client: Reads<Paths, Problems, Status>): ProblemsAsker<Paths, Problems, Status> {
  const inTurn = bounded(REQUESTS_AT_ONCE);
  let held = new Map<string, Promise<Paths[] | ReadFailed>>();

  const forget = (plugin?: PluginAddress) => {
    if (plugin === undefined) { held = new Map(); return; }
    held.delete(WHOLE_SET);
    held.delete(keyOf(plugin));
  };

  const filePathsOf = (plugin?: PluginAddress): Promise<Paths[] | ReadFailed> => {
    const key = keyOf(plugin);
    const answered = held.get(key);
    if (answered) return answered;
    const whole = held.get(WHOLE_SET);
    if (plugin !== undefined && whole) return whole.then((answer) => (isReadFailed(answer) ? answer : answer.filter((each) => keyOf(each.plugin) === key)));
    const asked = inTurn(() => client.getPluginFilePaths(plugin));
    held.set(key, asked);
    const keepIfComplete = (answer?: Paths[] | ReadFailed) => {
      const complete = answer !== undefined && !isReadFailed(answer) && answer.every(({ failure, unread }) => failure == null && unread.length === 0);
      if (!complete && held.get(key) === asked) held.delete(key);
    };
    asked.then(keepIfComplete, () => { keepIfComplete(); });
    return asked;
  };

  return {
    getPluginFilePaths: filePathsOf,
    getPluginProblems: (plugin) => inTurn(() => client.getPluginProblems(plugin)),
    onPluginChanged: (listener) => {
      const heard = (event: { plugin: PluginAddress }) => { forget(event.plugin); listener(event); };
      const off = [client.onNotification('rows-changed', heard), client.onNotification('plugin-changed', heard)];
      return () => { for (const stop of off) stop(); };
    },
    onLoadOrderSettled: (listener) => client.onLoadOrderSettled((status) => { forget(); listener(status); }),
    forget,
    inTurn,
  };
}
