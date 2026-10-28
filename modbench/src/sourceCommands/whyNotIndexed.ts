import type { MEditClient, PluginAddress } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { isPluginAtRoot } from '../tables/pluginFile';

const LOAD_ORDER_WAIT_MS = 120_000;
const RECHECK_MS = 250;

interface Deps {
  client: Pick<MEditClient, 'isPluginIndexedAsOnDisk' | 'onLoadOrderStatus'>;
  adapter: Pick<InstanceAdapter, 'reading'>;
}

/** Why mEdit's rows are not of the plugins `mod`'s folder gives the load order as they are on disk, once the bound passes; nothing once they are, or once `signal` aborts (ADR-0003). */
export async function whyNotIndexed({ client, adapter }: Deps, mod: string, signal?: AbortSignal): Promise<string | undefined> {
  const reading = await adapter.reading();
  const enabled = reading.mods.some((entry) => entry.kind === 'mod' && entry.name === mod && entry.enabled);
  const held = enabled ? reading.modFiles.get(mod) : undefined;
  const wanted: PluginAddress[] = held === undefined ? [] : held.files.filter((file) => !file.excluded && isPluginAtRoot(file.relativePath))
    .map((file) => ({ name: file.relativePath, origin: held.origin }));
  const lackingNow = async (): Promise<string[]> => (await Promise.all(wanted.map(async (plugin) => [plugin.name, await client.isPluginIndexedAsOnDisk(plugin)] as const)))
    .flatMap(([name, asOnDisk]) => {
      if (asOnDisk === true) return [];
      return [isReadFailed(asOnDisk) ? `${name} (${failureReason(asOnDisk)})` : name];
    });

  const deadline = Date.now() + LOAD_ORDER_WAIT_MS;
  for (;;) {
    const next = nextStatusOrRecheck(client, signal);
    const lacking = await lackingNow();
    if (lacking.length === 0 || signal?.aborted === true) { next.cancel(); return undefined; }
    if (Date.now() >= deadline) { next.cancel(); return `plugin ${lacking.join(', ')} did not reach the record index within ${String(LOAD_ORDER_WAIT_MS / 1000)} seconds`; }
    await next.woken;
  }
}

function nextStatusOrRecheck(client: Pick<MEditClient, 'onLoadOrderStatus'>, signal: AbortSignal | undefined): { woken: Promise<void>; cancel: () => void } {
  let cancel = (): void => undefined;
  const woken = new Promise<void>((resolve) => {
    const stop = client.onLoadOrderStatus(() => { cancel(); });
    const timer = setTimeout(() => { cancel(); }, RECHECK_MS);
    signal?.addEventListener('abort', () => { cancel(); }, { once: true });
    cancel = () => { clearTimeout(timer); stop(); resolve(); };
  });
  return { woken, cancel: () => { cancel(); } };
}
