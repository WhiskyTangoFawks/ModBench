import type { LoadOrderRefusal, PluginAddress, PluginLoadFailure } from '../MEditClient';
import type { InMemoryMEditClient } from './InMemoryMEditClient';

export interface Holds {
  /** Every plugin indexed and the winners computed. */
  readonly settled?: boolean;
  readonly version?: number;
  readonly total?: number;
  readonly indexed?: readonly PluginAddress[];
  readonly failures?: readonly PluginLoadFailure[];
  readonly refusal?: LoadOrderRefusal;
}

/** mEdit holds a load order: how far it has indexed it, which plugins it holds or failed, and, once settled or refused, the change that says everything. */
export function holdsLoadOrder(client: InMemoryMEditClient, holds: Holds = {}): void {
  const { settled = true, version = 1, indexed = [], failures = [], refusal } = holds;
  client.setProgress({
    done: indexed.length + failures.length, total: holds.total ?? indexed.length + failures.length, version, settled: settled && refusal === undefined,
    ...(refusal && { refusal }),
  });
  client.setQueryAnswer('getPluginsIndexing', [
    ...indexed.map(({ name, origin }) => ({ name, origin, state: 'Indexed' as const, changedOutside: false })),
    ...failures.map(({ name, origin, reason, diagnosis }) => ({ name, origin, state: 'Failed' as const, reason, diagnosis, changedOutside: false })),
  ]);
  if (settled || refusal !== undefined) client.change(undefined);
}

/** mEdit holds no load order. */
export function holdsNoLoadOrder(client: InMemoryMEditClient): void {
  client.setProgress(undefined);
}

/** The change event names a plugin, and the rows of it when `keys` are given. */
export function changeNamesPlugin(client: InMemoryMEditClient, plugin: { name: string; origin: string }, keys?: readonly string[]): void {
  client.change([{ plugin: { name: plugin.name, origin: plugin.origin }, ...(keys && { keys: [...keys] }) }]);
}
