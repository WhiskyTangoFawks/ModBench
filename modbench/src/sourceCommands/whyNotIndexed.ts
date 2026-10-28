import type { LoadOrderStatus, MEditClient } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { isPluginAtRoot } from '../tables/pluginFile';

/** How long a built mod's plugins have to reach the record index. mEdit indexes a large plugin in seconds. */
export const LOAD_ORDER_WAIT_MS = 120_000;

interface Deps {
  client: Pick<MEditClient, 'loadOrderStatus' | 'onLoadOrderStatus'>;
  adapter: Pick<InstanceAdapter, 'reading'>;
  loadOrderWaitMs?: number;
}

/** Answers why the record index does not hold the plugins `mod`'s folder gives the load order, or nothing once it does.
 *  The watch carries the change to mEdit (ADR-0003); this only waits on the status that arrives through it. */
export async function whyNotIndexed({ client, adapter, loadOrderWaitMs = LOAD_ORDER_WAIT_MS }: Deps, mod: string): Promise<string | undefined> {
  const reading = await adapter.reading();
  const enabled = reading.mods.some((entry) => entry.kind === 'mod' && entry.name === mod && entry.enabled);
  const held = enabled ? reading.modFiles.get(mod) : undefined;
  const wanted = (held?.files ?? []).filter((file) => !file.excluded && isPluginAtRoot(file.relativePath))
    .map((file) => ({ name: file.relativePath, origin: held?.origin ?? mod }));
  const missingFrom = (status: LoadOrderStatus | undefined): string[] => wanted
    .filter(({ name, origin }) => !(status?.indexedPlugins ?? []).some((indexed) => indexed.origin === origin && indexed.name.toLowerCase() === name.toLowerCase()))
    .map(({ name }) => name);

  if (missingFrom(client.loadOrderStatus).length === 0) return undefined;
  return await new Promise<string | undefined>((resolve) => {
    let missing = missingFrom(client.loadOrderStatus);
    const stop = client.onLoadOrderStatus((status) => {
      missing = missingFrom(status);
      if (missing.length === 0) done(undefined);
    });
    const timer = setTimeout(() => {
      done(`plugin ${missing.join(', ')} did not reach the record index within ${String(loadOrderWaitMs / 1000)} seconds`);
    }, loadOrderWaitMs);
    function done(why: string | undefined): void {
      clearTimeout(timer);
      stop();
      resolve(why);
    }
  });
}
