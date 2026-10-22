import { createNexus, type Nexus, type SecretStore } from '../nexus';

/** The secret store's second adapter: it holds in memory and tells every listener of a change. */
export function memorySecrets(): SecretStore & { held: Map<string, string> } {
  const held = new Map<string, string>();
  const listeners = new Set<(change: { key: string }) => void>();
  const changed = (key: string) => { for (const listener of listeners) listener({ key }); };
  return {
    held,
    get: (name) => Promise.resolve(held.get(name)),
    store: (name, value) => { held.set(name, value); changed(name); return Promise.resolve(); },
    delete: (name) => { held.delete(name); changed(name); return Promise.resolve(); },
    onDidChange: (listener) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
  };
}

export interface Sent { url: string; headers: Headers }

/** The real Nexus box over a memory secret store and a network that answers as told. */
export function nexusAnswering(answer: (key: string, url: string) => Response | Error): { nexus: Nexus; sent: Sent[]; secrets: ReturnType<typeof memorySecrets> } {
  const sent: Sent[] = [];
  const secrets = memorySecrets();
  const nexus = createNexus({
    secrets,
    applicationVersion: '1.2.3',
    fetch: (url, init) => {
      sent.push({ url, headers: new Headers(init.headers) });
      const result = answer(init.headers.apikey ?? '', url);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  });
  return { nexus, sent, secrets };
}

export const GOOD_KEY = 'good-key';

/** Nexus accepts GOOD_KEY and refuses every other. */
export const acceptingGoodKey = (key: string): Response => new Response('{"name":"someone"}', { status: key === GOOD_KEY ? 200 : 401 });
