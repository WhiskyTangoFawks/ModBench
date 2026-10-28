import type { MEditClient, PluginAddress } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { isPluginAtRoot } from '../tables/pluginFile';

const LOAD_ORDER_WAIT_MS = 120_000;
const RECHECK_MS = 250;

interface Deps {
  client: Pick<MEditClient, 'getPluginIndexing' | 'onLoadOrderStatus'>;
  adapter: Pick<InstanceAdapter, 'reading'>;
}

interface Held { readonly mod: string; readonly plugin: PluginAddress }
type Verdict = { readonly kind: 'done' } | { readonly kind: 'waiting'; readonly why: string } | { readonly kind: 'failed'; readonly why: string };
type Standing = { readonly mod: string } & Verdict;

/** Why mEdit's rows are not of the plugins each of `mods` gives the load order as they are on disk, by mod: once a plugin's read has failed, or the bound
 *  passes. A mod it holds as on disk has no entry, and a `signal` that aborts ends the wait with what is known (ADR-0003). */
export async function whyNotIndexed({ client, adapter }: Deps, mods: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, string>> {
  const reading = await adapter.reading();
  const held: Held[] = mods.flatMap((mod) => {
    const files = reading.mods.some((entry) => entry.kind === 'mod' && entry.name === mod && entry.enabled) ? reading.modFiles.get(mod) : undefined;
    if (files === undefined) return [];
    return files.files.filter((file) => !file.excluded && isPluginAtRoot(file.relativePath)).map((file) => ({ mod, plugin: { name: file.relativePath, origin: files.origin } }));
  });
  const standings = (): Promise<Standing[]> => Promise.all(held.map(async ({ mod, plugin }) => ({ mod, ...standingOf(plugin, await client.getPluginIndexing(plugin)) })));
  const whyByMod = (now: readonly Standing[], timedOut: boolean): Map<string, string> => {
    const why = new Map<string, string[]>();
    for (const standing of now) {
      if (standing.kind === 'done' || (standing.kind === 'waiting' && !timedOut)) continue;
      why.set(standing.mod, [...(why.get(standing.mod) ?? []), standing.kind === 'failed' ? standing.why : `${standing.why} did not reach the record index within ${String(LOAD_ORDER_WAIT_MS / 1000)} seconds`]);
    }
    return new Map([...why].map(([mod, whys]) => [mod, whys.join('; ')]));
  };

  const deadline = Date.now() + LOAD_ORDER_WAIT_MS;
  for (;;) {
    const next = nextStatusOrRecheck(client, signal);
    const now = await standings();
    const settled = now.every(({ kind }) => kind !== 'waiting');
    if (settled || signal?.aborted === true || Date.now() >= deadline) {
      next.cancel();
      return whyByMod(now, !settled && signal?.aborted !== true);
    }
    await next.woken;
  }
}

function standingOf(plugin: PluginAddress, answer: Awaited<ReturnType<MEditClient['getPluginIndexing']>>): Verdict {
  if (isReadFailed(answer)) return { kind: 'waiting', why: `plugin ${plugin.name} (${failureReason(answer)})` };
  if (answer.state === 'AsOnDisk') return { kind: 'done' };
  if (answer.state === 'ReadFailed') return { kind: 'failed', why: `plugin ${plugin.name} could not be read: ${answer.reason ?? 'mEdit gave no reason'}` };
  return { kind: 'waiting', why: `plugin ${plugin.name}` };
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
