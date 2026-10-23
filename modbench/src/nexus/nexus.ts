import { errorMessage } from '../ports/errorMessage';
import { lookupByMd5, lookupByName, type FileFound, type Read } from './fileLookup';
import { fileListOf, newestVersionOf, type InstalledFile } from './updateChain';

const API = 'https://api.nexusmods.com';
const KEY_NAME = 'modbench.nexus.apiKey';

type Disposable = { dispose: () => void };

export interface SecretStore {
  get: (name: string) => PromiseLike<string | undefined>;
  store: (name: string, value: string) => PromiseLike<void>;
  delete: (name: string) => PromiseLike<void>;
  onDidChange: (listener: (change: { key: string }) => void) => Disposable;
}

type KeyCheck = { valid: true } | { valid: false; reason: string };

interface NexusFile extends InstalledFile {
  readonly game: string;
  readonly modId: string;
  /** Nexus's category of the installed file, as the mod's metadata recorded it. */
  readonly fileStatus?: number;
}

export const NOT_LOGGED_IN = 'You are not logged in to Nexus.';
const OPTIONAL_FILE = 3;
const MISCELLANEOUS_FILE = 5;

type NewestVersion = { found: true; version: string } | { found: false; reason: string };


export interface Nexus {
  /** Asks Nexus whether `key` works. Keeps nothing. */
  check: (key: string) => Promise<KeyCheck>;
  keep: (key: string) => Promise<void>;
  forget: () => Promise<void>;
  loggedIn: () => Promise<boolean>;
  /** The version of the newest file that replaces the installed one, or of the mod page when the installed file cannot be told. */
  newestVersion: (file: NexusFile) => Promise<NewestVersion>;
  /** What Nexus knows of the file `fileName` whose MD5 is `md5`, asking each of `games` in turn. */
  fileByMd5: (file: { games: readonly string[]; md5: string; fileName: string }) => Promise<FileFound>;
  /** What Nexus knows of the file `fileName` of mod `modID`, from the mod's page and file list; from its page alone when `fileID` is known. */
  fileByName: (file: { game: string; modID: string; fileID?: string; fileName: string }) => Promise<FileFound>;
  /** Fires when a key is kept or forgotten, from any window. */
  onDidChangeLogin: (listener: () => void) => Disposable;
}

interface NexusDeps {
  secrets: SecretStore;
  applicationVersion: string;
  fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
}

export function createNexus({ secrets, applicationVersion, fetch }: NexusDeps): Nexus {
  const get = (key: string, path: string): Promise<Response> =>
    fetch(`${API}${path}`, { headers: { apikey: key, 'Application-Name': 'Modbench', 'Application-Version': applicationVersion } });
  const read = async (key: string, path: string, notFound = 'Nexus does not hold this mod.'): Promise<{ json: unknown } | { reason: string }> => {
    try {
      const response = await get(key, path);
      if (response.status === 404) return { reason: notFound };
      if (!response.ok) return { reason: `Nexus answered ${response.status}.` };
      return { json: await response.json().catch(() => undefined) };
    } catch (error) {
      return { reason: `Could not reach Nexus: ${errorMessage(error)}` };
    }
  };
  const withKey = async (lookup: (ask: Read) => Promise<FileFound>): Promise<FileFound> => {
    const key = await secrets.get(KEY_NAME);
    return key === undefined ? { found: false, reason: NOT_LOGGED_IN } : lookup((path, notFound) => read(key, path, notFound));
  };
  return {
    check: async (key) => {
      try {
        const { ok, status } = await get(key, '/v1/users/validate.json');
        if (ok) return { valid: true };
        return { valid: false, reason: status === 401 ? 'Nexus refused this key.' : `Nexus answered ${status}.` };
      } catch (error) {
        return { valid: false, reason: `Could not reach Nexus: ${errorMessage(error)}` };
      }
    },
    keep: async (key) => { await secrets.store(KEY_NAME, key); },
    forget: async () => { await secrets.delete(KEY_NAME); },
    loggedIn: async () => (await secrets.get(KEY_NAME)) !== undefined,
    newestVersion: async ({ game, modId, fileStatus, ...installed }) => {
      const key = await secrets.get(KEY_NAME);
      if (key === undefined) return { found: false, reason: NOT_LOGGED_IN };
      const mod = `/v1/games/${game}/mods/${modId}`;
      const listed = await read(key, `${mod}/files.json`);
      if ('reason' in listed) return { found: false, ...listed };
      const list = fileListOf(listed.json);
      if (list === undefined) return { found: false, reason: 'Nexus answered its file list in a form Modbench does not read.' };
      const chained = newestVersionOf(list, installed);
      if (chained !== undefined) return { found: true, version: chained };
      if (fileStatus === OPTIONAL_FILE || fileStatus === MISCELLANEOUS_FILE) {
        return { found: false, reason: "its file is an optional or miscellaneous file, whose version is not the mod's" };
      }
      const page = await read(key, `${mod}.json`);
      if ('reason' in page) return { found: false, ...page };
      const version = typeof page.json === 'object' && page.json !== null && 'version' in page.json ? page.json.version : undefined;
      return typeof version === 'string' ? { found: true, version } : { found: false, reason: 'Nexus named no version.' };
    },
    fileByMd5: (file) => withKey((ask) => lookupByMd5(ask, file)),
    fileByName: (file) => withKey((ask) => lookupByName(ask, file)),
    onDidChangeLogin: (listener) => secrets.onDidChange(({ key }) => { if (key === KEY_NAME) listener(); }),
  };
}
