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

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

export const FILE_78 = {
  record: 'https://api.nexusmods.com/v1/games/fallout4/mods/7/files/78.json',
  modPage: 'https://api.nexusmods.com/v1/games/fallout4/mods/7.json',
  link: 'https://api.nexusmods.com/v1/games/fallout4/mods/7/files/78/download_link.json',
  server: 'https://cdn.example/Sleep-7-1-2.7z?md5=x&expires=1',
  /** Its page on Nexus as the Instance adapter formats it. */
  page: 'https://www.nexusmods.com/fallout4/mods/7?tab=files&file_id=78',
};

/** What Nexus answers, by URL, of file 78 of mod 7, whose first server sends `bytes`. */
export const servingFile78 = (bytes: string): Record<string, Response | Error> => ({
  [FILE_78.record]: json({ file_id: 78, name: 'Main', version: '1.2', mod_version: '1.0', category_id: 1, uploaded_timestamp: 1700000000, description: 'Main file', file_name: 'Sleep-7-1-2.7z' }),
  [FILE_78.modPage]: json({ name: 'Sleep &amp; Save', category_id: 12, author: 'Someone', uploaded_by: 'Uploader', uploaded_users_profile_url: 'https://nexus/users/1' }),
  [FILE_78.link]: json([{ name: 'Nexus CDN', short_name: 'Nexus CDN', URI: FILE_78.server }, { name: 'Paris', short_name: 'Paris', URI: 'https://paris.example/f' }]),
  [FILE_78.server]: new Response(bytes, { status: 200 }),
});

/** Answers each URL from `answers`, and 404 for any other. */
export const answeringFrom = (answers: Record<string, Response | Error>) => (_key: string, url: string): Response | Error =>
  answers[url] ?? new Response('', { status: 404 });
