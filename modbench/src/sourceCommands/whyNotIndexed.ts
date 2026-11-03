import type { MEditClient, PluginAddress } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { failureReason, isNotYetAnswerable, isReadFailed } from '../wire/readFailed';
import { isPluginAtRoot } from '../tables/pluginFile';

const RECHECK_MS = 250;

interface Deps {
  client: Pick<MEditClient, 'getPluginIndexing' | 'onLoadOrderStatus'>;
  adapter: Pick<InstanceAdapter, 'reading'>;
}

interface Held { readonly mod: string; readonly plugin: PluginAddress }
type Verdict = { readonly kind: 'done' } | { readonly kind: 'waiting' } | { readonly kind: 'failed'; readonly why: string };
type Standing = { readonly mod: string } & Verdict;

/** Why mEdit's rows are not of the plugins at the root of each enabled mod, as on disk, by mod: only a failed read gives one. Waits while mEdit has not indexed a plugin or cannot yet answer for it, until every plugin settles or an aborted `signal` ends it (ADR-0003). */
export async function whyNotIndexed({ client, adapter }: Deps, mods: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, string>> {
  const reading = await adapter.reading();
  const held: Held[] = mods.flatMap((mod) => {
    const files = reading.mods.some((entry) => entry.kind === 'mod' && entry.name === mod && entry.enabled) ? reading.modFiles.get(mod) : undefined;
    if (files === undefined) return [];
    return files.files.filter((file) => !file.excluded && isPluginAtRoot(file.relativePath)).map((file) => ({ mod, plugin: { name: file.relativePath, origin: files.origin } }));
  });
  const standings = (): Promise<Standing[]> => Promise.all(held.map(async ({ mod, plugin }) => ({ mod, ...standingOf(plugin, await client.getPluginIndexing(plugin)) })));
  const whyByMod = (now: readonly Standing[]): Map<string, string> => {
    const why = new Map<string, string[]>();
    for (const standing of now) {
      if (standing.kind === 'failed') why.set(standing.mod, [...(why.get(standing.mod) ?? []), standing.why]);
    }
    return new Map([...why].map(([mod, whys]) => [mod, whys.join('; ')]));
  };

  for (;;) {
    const next = nextStatusOrRecheck(client, signal);
    const now = await standings();
    if (now.every(({ kind }) => kind !== 'waiting') || signal?.aborted === true) {
      next.cancel();
      return whyByMod(now);
    }
    await next.woken;
  }
}

function standingOf(plugin: PluginAddress, answer: Awaited<ReturnType<MEditClient['getPluginIndexing']>>): Verdict {
  if (isReadFailed(answer) && isNotYetAnswerable(answer)) return { kind: 'waiting' };
  if (isReadFailed(answer)) return { kind: 'failed', why: `plugin ${plugin.name} (${failureReason(answer)})` };
  if (answer.state === 'AsOnDisk') return { kind: 'done' };
  if (answer.state === 'ReadFailed') return { kind: 'failed', why: `plugin ${plugin.name} could not be read: ${answer.reason ?? 'mEdit gave no reason'}` };
  return { kind: 'waiting' };
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
