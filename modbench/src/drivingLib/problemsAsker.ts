import { bounded, REQUESTS_AT_ONCE, type InTurn } from '../ports/bounded';
import { askedAgain, keyOf, WHOLE_SET, type Read } from './askedAgain';
import type { PluginAddress } from '../wire/pluginAddress';
import { isReadFailed, type ReadFailed } from '../wire/readFailed';

interface Answered { plugin: PluginAddress; failure?: string | null; unread: string[] }

interface Reads<Paths extends Answered, Problems> {
  getPluginFilePaths(plugin?: PluginAddress): Promise<Paths[] | ReadFailed>;
  getPluginProblems(plugin?: PluginAddress): Promise<Problems[] | ReadFailed>;
  onDidChange(listener: (change: readonly { readonly plugin: PluginAddress }[] | undefined) => void): { dispose(): void };
}

/** A plugin-changed listener that asks of the one plugin named, or of the whole set when none is. */
export function askingOnChange(whole: () => void, plugin: (changed: { plugin: PluginAddress }) => void): (event: { plugin?: PluginAddress }) => void {
  return (event) => { if (event.plugin === undefined) whole(); else plugin({ plugin: event.plugin }); };
}

export interface ProblemsAsker<Paths extends Answered, Problems> {
  getPluginFilePaths: Reads<Paths, Problems>['getPluginFilePaths'];
  getPluginProblems: Reads<Paths, Problems>['getPluginProblems'];
  /** Told after the asker dropped what it held of the plugin, or of every plugin when no plugin is named. */
  onPluginChanged(listener: (event: { plugin?: PluginAddress }) => void): () => void;
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

  const filePathsOf = (plugin?: PluginAddress): Promise<Paths[] | ReadFailed> => {
    const key = keyOf(plugin);
    const answered = held.get(key);
    if (answered) return answered;
    const whole = held.get(WHOLE_SET);
    if (plugin !== undefined && whole) return whole.then((answer) => (isReadFailed(answer) ? answer : answer.filter((each) => keyOf(each.plugin) === key)));
    const asked = inTurn(() => client.getPluginFilePaths(plugin));
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
    getPluginProblems: (plugin) => {
      const asked = inTurn(() => client.getPluginProblems(plugin));
      retries.watch('getPluginProblems', plugin, asked);
      return asked;
    },
    dispose: () => { retries.dispose(); },
    onAskedAgain: (read, listener) => retries.onAskedAgain(read, listener),
    onPluginChanged: (listener) => {
      const subscription = client.onDidChange((change) => {
        if (change === undefined) { forget(); listener({}); return; }
        for (const { plugin } of change) { forget(plugin); listener({ plugin }); }
      });
      return () => { subscription.dispose(); };
    },
    forget,
    inTurn,
  };
}
