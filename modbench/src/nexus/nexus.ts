const API = 'https://api.nexusmods.com';
const KEY_NAME = 'modbench.nexus.apiKey';

export interface SecretStore {
  get: (name: string) => PromiseLike<string | undefined>;
  store: (name: string, value: string) => PromiseLike<void>;
  delete: (name: string) => PromiseLike<void>;
}

type KeyCheck = { valid: true } | { valid: false; reason: string };

/** Modbench's one reach to Nexus. */
export interface Nexus {
  /** Asks Nexus whether `key` works. Keeps nothing. */
  check: (key: string) => Promise<KeyCheck>;
  keep: (key: string) => Promise<void>;
  forget: () => Promise<void>;
  loggedIn: () => Promise<boolean>;
}

interface NexusDeps {
  secrets: SecretStore;
  applicationVersion: string;
  fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
}

export function createNexus({ secrets, applicationVersion, fetch }: NexusDeps): Nexus {
  const get = (key: string, path: string): Promise<Response> =>
    fetch(`${API}${path}`, { headers: { apikey: key, 'Application-Name': 'Modbench', 'Application-Version': applicationVersion } });
  return {
    check: async (key) => {
      try {
        const { ok, status } = await get(key, '/v1/users/validate.json');
        if (ok) return { valid: true };
        return { valid: false, reason: status === 401 ? 'Nexus refused this key.' : `Nexus answered ${status}.` };
      } catch (error) {
        return { valid: false, reason: `Could not reach Nexus: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    keep: async (key) => { await secrets.store(KEY_NAME, key); },
    forget: async () => { await secrets.delete(KEY_NAME); },
    loggedIn: async () => (await secrets.get(KEY_NAME)) !== undefined,
  };
}
