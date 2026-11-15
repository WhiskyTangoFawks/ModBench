import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';
import { isReadFailed, type ReadFailed } from '../wire/readFailed';

export type Read = 'getPluginFilePaths' | 'getPluginProblems';

export const WHOLE_SET = '';
export const keyOf = (plugin?: PluginAddress): string => plugin === undefined ? WHOLE_SET : pluginAddressKey(plugin);

export interface AskedAgain {
  /** A failure of the newest ask of a read and target is told again after a delay; its answer, or the whole set's, ends the retry. */
  watch(read: Read, plugin: PluginAddress | undefined, asked: Promise<unknown[] | ReadFailed>): void;
  onAskedAgain(read: Read, listener: (plugin?: PluginAddress) => void): () => void;
  dispose(): void;
}

export function askedAgain(retryAfterMs: number): AskedAgain {
  const listeners: Record<Read, Set<(plugin?: PluginAddress) => void>> = { getPluginFilePaths: new Set(), getPluginProblems: new Set() };
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const latest = new Map<string, number>();
  let asks = 0;
  let disposed = false;

  const stopRetrying = (id: string) => {
    clearTimeout(pending.get(id));
    pending.delete(id);
  };
  const tell = (read: Read, plugin?: PluginAddress) => { for (const listener of listeners[read]) listener(plugin); };
  const retryFailed = (id: string, read: Read, plugin?: PluginAddress) => {
    if (disposed || pending.has(id)) return;
    pending.set(id, setTimeout(() => {
      pending.delete(id);
      tell(read, plugin);
    }, retryAfterMs));
  };

  return {
    watch: (read, plugin, asked) => {
      const id = `${read}\n${keyOf(plugin)}`;
      asks += 1;
      const mine = asks;
      latest.set(id, mine);
      const settled = (failed: boolean) => {
        if (latest.get(id) !== mine) return;
        latest.delete(id);
        if (failed) { retryFailed(id, read, plugin); return; }
        const ended = [...pending.keys()].filter((key) => plugin === undefined ? key.startsWith(`${read}\n`) : key === id);
        for (const each of ended) stopRetrying(each);
        if (ended.length > 0 && read === 'getPluginFilePaths') tell(read, plugin);
      };
      asked.then((answer) => { settled(isReadFailed(answer)); }, () => { settled(true); });
    },
    onAskedAgain: (read, listener) => {
      listeners[read].add(listener);
      return () => { listeners[read].delete(listener); };
    },
    dispose: () => {
      disposed = true;
      for (const id of [...pending.keys()]) stopRetrying(id);
    },
  };
}
