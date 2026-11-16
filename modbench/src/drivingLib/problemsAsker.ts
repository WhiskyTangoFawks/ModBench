import type { PluginChanged, PluginRecords } from './namedPlugins';
import { bounded, REQUESTS_AT_ONCE, type InTurn } from '../ports/bounded';
import { askedAgain, keyOf, WHOLE_SET, type Read } from './askedAgain';
import type { PluginAddress } from '../wire/pluginAddress';
import { isReadFailed, type ReadFailed } from '../wire/readFailed';

interface Answered { plugin: PluginAddress; failure?: string | null; unread: string[] }

interface Reads<Paths extends Answered, Problems> {
  getPluginFilePaths(plugin?: PluginAddress, token?: undefined, keys?: readonly string[]): Promise<Paths[] | ReadFailed>;
  getPluginProblems(plugin?: PluginAddress, token?: undefined, keys?: readonly string[]): Promise<Problems[] | ReadFailed>;
  onDidChange(listener: (change: readonly { readonly plugin: PluginAddress; readonly keys?: readonly string[] }[] | undefined) => void): { dispose(): void };
}

/** A plugin-changed listener that asks of the one plugin named, with the records the change names, or of the whole set when none is. */
export function askingOnChange(whole: () => void, plugin: (changed: PluginRecords) => void): (event: PluginChanged) => void {
  return (event) => { if (event.plugin === undefined) whole(); else plugin({ plugin: event.plugin, keys: event.keys }); };
}

export interface ProblemsAsker<Paths extends Answered, Problems> {
  getPluginFilePaths(plugin?: PluginAddress, keys?: readonly string[]): Promise<Paths[] | ReadFailed>;
  getPluginProblems(plugin?: PluginAddress, keys?: readonly string[]): Promise<Problems[] | ReadFailed>;
  /** Told after the asker dropped what it held of the plugin, or of every plugin when no plugin is named; `keys` are the records a change names. */
  onPluginChanged(listener: (event: PluginChanged) => void): () => void;
  /** Told to ask again of a read that failed: after a delay, and, for the file paths the asker holds, at once when another ask of them is answered. */
  onAskedAgain(read: Read, listener: (plugin?: PluginAddress) => void): () => void;
  forget(plugin?: PluginAddress): void;
  dispose(): void;
  inTurn: InTurn;
}

const RETRY_AFTER_MS = 15_000;

export function problemsAsker<Paths extends Answered, Problems>(client: Reads<Paths, Problems>, retryAfterMs = RETRY_AFTER_MS): ProblemsAsker<Paths, Problems> {
  const inTurn = bounded(REQUESTS_AT_ONCE);
  let held = new Map<string, Promise<Paths[] | ReadFailed>>();
  const retries = askedAgain(retryAfterMs);

  const forget = (plugin?: PluginAddress) => {
    if (plugin === undefined) { held = new Map(); return; }
    held.delete(WHOLE_SET);
    held.delete(keyOf(plugin));
  };

  const filePathsOf = (plugin?: PluginAddress, keys?: readonly string[]): Promise<Paths[] | ReadFailed> => {
    const key = keyOf(plugin);
    const answered = held.get(key);
    if (answered) return answered;
    const whole = held.get(WHOLE_SET);
    if (plugin !== undefined && whole) return whole.then((answer) => (isReadFailed(answer) ? answer : answer.filter((each) => keyOf(each.plugin) === key)));
    const asked = inTurn(() => client.getPluginFilePaths(plugin, undefined, keys));
    held.set(key, asked);
    retries.watch('getPluginFilePaths', plugin, asked);
    const keepIfComplete = (answer?: Paths[] | ReadFailed) => {
      const complete = answer !== undefined && !isReadFailed(answer) && answer.every(({ failure, unread }) => failure == null && unread.length === 0);
      if (!complete && held.get(key) === asked) held.delete(key);
    };
    asked.then(keepIfComplete, () => { keepIfComplete(); });
    return asked;
  };

  return {
    getPluginFilePaths: filePathsOf,
    getPluginProblems: (plugin, keys) => {
      const asked = inTurn(() => client.getPluginProblems(plugin, undefined, keys));
      retries.watch('getPluginProblems', plugin, asked);
      return asked;
    },
    dispose: () => { retries.dispose(); },
    onAskedAgain: (read, listener) => retries.onAskedAgain(read, listener),
    onPluginChanged: (listener) => {
      const subscription = client.onDidChange((change) => {
        if (change === undefined) { forget(); listener({}); return; }
        for (const { plugin, keys } of change) { forget(plugin); listener({ plugin, keys }); }
      });
      return () => { subscription.dispose(); };
    },
    forget,
    inTurn,
  };
}
