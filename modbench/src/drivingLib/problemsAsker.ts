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
  /** Told, after a delay, to ask again of a read that failed, until its own ask is answered. */
  onAskedAgain(read: Read, listener: (plugin?: PluginAddress) => void): () => void;
  forget(plugin?: PluginAddress): void;
  dispose(): void;
  inTurn: InTurn;
}

type Read = 'getPluginFilePaths' | 'getPluginProblems';

const RETRY_AFTER_MS = 15_000;

const WHOLE_SET = '';
const keyOf = (plugin?: PluginAddress): string => plugin === undefined ? WHOLE_SET : pluginAddressKey(plugin);

export function problemsAsker<Paths extends Answered, Problems, Status>(client: Reads<Paths, Problems, Status>, retryAfterMs = RETRY_AFTER_MS): ProblemsAsker<Paths, Problems, Status> {
  const inTurn = bounded(REQUESTS_AT_ONCE);
  let held = new Map<string, Promise<Paths[] | ReadFailed>>();
  const listeners: Record<Read, Set<(plugin?: PluginAddress) => void>> = { getPluginFilePaths: new Set(), getPluginProblems: new Set() };
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const latest = new Map<string, Promise<unknown>>();
  const retryId = (read: Read, plugin?: PluginAddress) => `${read}\n${keyOf(plugin)}`;

  const stopRetrying = (id: string) => {
    clearTimeout(pending.get(id));
    pending.delete(id);
  };

  const forget = (plugin?: PluginAddress) => {
    if (plugin === undefined) { held = new Map(); return; }
    held.delete(WHOLE_SET);
    held.delete(keyOf(plugin));
  };

  const retryFailed = (id: string, read: Read, plugin?: PluginAddress) => {
    if (pending.has(id)) return;
    pending.set(id, setTimeout(() => {
      pending.delete(id);
      for (const listener of listeners[read]) listener(plugin);
    }, retryAfterMs));
  };

  const askedAgainIfFailed = <T>(read: Read, plugin: PluginAddress | undefined, asked: Promise<T[] | ReadFailed>) => {
    const id = retryId(read, plugin);
    latest.set(id, asked);
    const settled = (failed: boolean) => {
      if (latest.get(id) !== asked) return;
      if (failed) retryFailed(id, read, plugin);
      else for (const each of [...pending.keys()].filter((key) => plugin === undefined ? key.startsWith(`${read}\n`) : key === id)) stopRetrying(each);
    };
    asked.then((answer) => { settled(isReadFailed(answer)); }, () => { settled(true); });
  };

  const filePathsOf = (plugin?: PluginAddress): Promise<Paths[] | ReadFailed> => {
    const key = keyOf(plugin);
    const answered = held.get(key);
    if (answered) return answered;
    const whole = held.get(WHOLE_SET);
    if (plugin !== undefined && whole) return whole.then((answer) => (isReadFailed(answer) ? answer : answer.filter((each) => keyOf(each.plugin) === key)));
    const asked = inTurn(() => client.getPluginFilePaths(plugin));
    held.set(key, asked);
    askedAgainIfFailed('getPluginFilePaths', plugin, asked);
    const keepIfComplete = (answer?: Paths[] | ReadFailed) => {
      const complete = answer !== undefined && !isReadFailed(answer) && answer.every(({ failure, unread }) => failure == null && unread.length === 0);
      if (!complete && held.get(key) === asked) held.delete(key);
    };
    asked.then(keepIfComplete, () => { keepIfComplete(); });
    return asked;
  };

  return {
    getPluginFilePaths: filePathsOf,
    getPluginProblems: (plugin) => {
      const asked = inTurn(() => client.getPluginProblems(plugin));
      askedAgainIfFailed('getPluginProblems', plugin, asked);
      return asked;
    },
    dispose: () => {
      for (const id of [...pending.keys()]) stopRetrying(id);
    },
    onAskedAgain: (read, listener) => {
      listeners[read].add(listener);
      return () => { listeners[read].delete(listener); };
    },
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
