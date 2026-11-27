import { createSymbols, type SymbolRows } from '..';
import type { Concerns, InstanceSubscriber, InstanceValue, ReadsFile } from '../../instanceLoader/instance';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { problemsAsker } from '../../drivingLib/problemsAsker';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { host } from './vscodeHost';

type Deps = Parameters<typeof createSymbols>[0];

/** An instance whose value the test lands with the files it read again, telling each subscriber of a change to a fact
 *  it reads or to a file it reads, as the Instance loader does. */
export function instanceHolding(value: InstanceValue) {
  const subscribers = new Set<{ told: InstanceSubscriber; reads: (before: InstanceValue, paths: readonly string[]) => boolean }>();
  const instance = {
    value,
    subscribe: <K extends keyof InstanceValue>(subscriber: InstanceSubscriber<K>, concerns?: Concerns<K>, readsFile?: ReadsFile<K>) => {
      const held = {
        told: (next: InstanceValue, sequence: number, heard: Parameters<InstanceSubscriber>[2]) => subscriber(next, sequence, heard),
        reads: (before: InstanceValue, paths: readonly string[]) => concerns === undefined
          || Object.keys(concerns).some((fact) => Reflect.get(before, fact) !== Reflect.get(instance.value, fact))
          || paths.some((path) => readsFile?.(path, instance.value) ?? false),
      };
      subscribers.add(held);
      return { dispose: () => { subscribers.delete(held); } };
    },
    land: (next: InstanceValue, paths: readonly string[] = []) => {
      const before = instance.value;
      instance.value = next;
      for (const { told, reads } of [...subscribers]) if (reads(before, paths)) void told(next, 1, { named: paths, disk: false, before, changed: () => 'every' });
    },
  };
  return instance;
}

/** What the views say of their rows: none shown, nothing selected, until the test says otherwise. */
export const rowsOf = (over: { plugins?: Partial<SymbolRows['plugins']>; mods?: Partial<SymbolRows['mods']> } & Partial<Omit<SymbolRows, 'plugins' | 'mods'>> = {}): SymbolRows => ({
  selection: () => [], filesHeld: () => ({ filesByMod: new Map(), dataFolderFiles: { kind: 'listed', files: new Map() } }), ...over,
  plugins: { selected: () => undefined, show: () => undefined, fileOf: () => undefined, ...over.plugins },
  mods: { selected: () => undefined, show: () => undefined, folderOf: () => undefined, dataPathOf: () => undefined, fileTooltip: () => undefined, ...over.mods },
});

export const sourceFolders: Deps['sourceFiles'] = (origin) => ({ file: (relativePath) => `/source/${origin}/${relativePath}` });

interface Over extends Partial<Omit<Deps, 'client' | 'asker'>> {
  /** Scripts mEdit before the box first asks it. */
  arrange?: (client: InMemoryMEditClient) => void;
}

/** The Symbols box in a fresh VS Code, over an instance that holds nothing and an mEdit that answers nothing until
 *  scripted. */
export function symbolsOver({ arrange, ...over }: Over = {}) {
  host.reset();
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPluginSourceNames', []);
  client.setQueryAnswer('getPluginFilePaths', []);
  client.setQueryAnswer('getPlugins', []);
  client.setQueryAnswer('searchRecords', { items: [], total: 0 });
  arrange?.(client);
  const reporter = recordingReporter();
  const files = new Map<string, string>();
  const symbols = createSymbols({
    instance: instanceHolding(instanceValueFixture()), reporter, client, asker: problemsAsker(client), names: client,
    focusedRecord: () => undefined, sourceFiles: sourceFolders, savedText: (path) => Promise.resolve(files.get(path)),
    fileCopies: { copyOf: () => ({ none: 'No mod holds it.' }), reveal: () => Promise.resolve() },
    owners: [], entryOwners: [], entryTooltip: () => undefined, downloadedFileTooltip: () => undefined, downloadedFileRow: () => undefined,
    modOrderFileOf: () => undefined, pluginsShown: undefined, reporterFor: () => reporter, rows: undefined,
    ...over,
  });
  return { client, reporter, files, symbols: symbols.symbols, dispose: () => { symbols.dispose(); } };
}
