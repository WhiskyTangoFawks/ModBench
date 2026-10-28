import type { MEditClient, PluginAddress } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { isPluginAtRoot } from '../tables/pluginFile';

const LOAD_ORDER_WAIT_MS = 120_000;
const RECHECK_MS = 250;

interface Deps {
  client: Pick<MEditClient, 'isPluginIndexedAsOnDisk' | 'onLoadOrderStatus'>;
  adapter: Pick<InstanceAdapter, 'reading'>;
  loadOrderWaitMs?: number;
}

/** Why the record index does not hold the plugins `mod`'s folder gives the load order as they are on disk, once the bound passes; nothing once it does.
 *  The watch carries the change (ADR-0003); this asks mEdit whether its rows are of the file now there. */
export async function whyNotIndexed({ client, adapter, loadOrderWaitMs = LOAD_ORDER_WAIT_MS }: Deps, mod: string): Promise<string | undefined> {
  const reading = await adapter.reading();
  const enabled = reading.mods.some((entry) => entry.kind === 'mod' && entry.name === mod && entry.enabled);
  const held = enabled ? reading.modFiles.get(mod) : undefined;
  const wanted: PluginAddress[] = (held?.files ?? []).filter((file) => !file.excluded && isPluginAtRoot(file.relativePath))
    .map((file) => ({ name: file.relativePath, origin: held?.origin ?? mod }));
  const missing = async (): Promise<string[]> => (await Promise.all(wanted.map(async (plugin) => [plugin.name, await client.isPluginIndexedAsOnDisk(plugin)] as const)))
    .filter(([, asOnDisk]) => asOnDisk !== true).map(([name]) => name);

  const deadline = Date.now() + loadOrderWaitMs;
  for (let lacking = await missing(); lacking.length > 0; lacking = await missing()) {
    if (Date.now() >= deadline) return `plugin ${lacking.join(', ')} did not reach the record index within ${String(loadOrderWaitMs / 1000)} seconds`;
    await nextStatusOrRecheck(client);
  }
  return undefined;
}

function nextStatusOrRecheck(client: Pick<MEditClient, 'onLoadOrderStatus'>): Promise<void> {
  return new Promise((resolve) => {
    const stop = client.onLoadOrderStatus(() => { wake(); });
    const timer = setTimeout(() => { wake(); }, RECHECK_MS);
    function wake(): void {
      clearTimeout(timer);
      stop();
      resolve();
    }
  });
}
