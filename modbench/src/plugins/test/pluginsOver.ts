import { createPlugins, PLUGINS_KEY_ARGS } from '..';
import type { InstanceValue } from '../../instanceLoader/instance';
import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';
import type { PluginSyncRun } from '../../pluginCommands/plugins';
import type { FileReads } from '../../sortingRules/lootConditions';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import type { loadFailuresOf, PluginAddress, PluginDiagnosisReport, PluginLoadFailure, PluginMetadata, LoadOrderRefusal } from '../../client';
import { isReadFailed, type ReadFailed } from '../../wire/readFailed';
import { READ_SORTING_RULE_FILES } from '../../test/readSortingRuleFiles';
import { holdsLoadOrder } from '../../client/test/says';
import { settled } from '../../test/eventually';
import { NO_MOD_STATUSES } from '../../test/noModStatuses';
import { recordingReporter, scriptedDialog, type RecordingReporter } from '../../test/surfacingDoubles';
import { pluginArgumentOf } from '../../drivingLib/argument';
import { pluginAddressKey, samePluginAddress } from '../../wire/pluginAddress';
import { host, ThemeIcon } from './vscodeHost';

type Deps = Parameters<typeof createPlugins>[0];
type InstanceDeps = Parameters<ReturnType<typeof createPlugins>['onInstance']>[0];

/** An mEdit that holds no plugin, no diagnosis, no filter and no change beneath a row, until the test scripts more. */
export function clientHoldingNothing(): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getWorkingTreeStatesBeneath', { plugin: [], recordTypes: {}, records: {} });
  client.setQueryAnswer('getPlugins', []);
  client.setQueryAnswer('getDiagnoses', []);
  client.setQueryAnswer('getFilterCleared', null);
  return client;
}

/** The Instance adapter's reads of the files LOOT's conditions name: each file is missing. */
export const NO_FILE_READS: FileReads = {
  checksum: () => Promise.resolve({ kind: 'read', value: undefined }), version: () => Promise.resolve({ kind: 'read', value: undefined }),
  readable: () => Promise.resolve({ kind: 'read', value: false }), trusting: (read) => read(),
};

interface Over extends Partial<Omit<Deps, 'client' | 'facts'>>, Partial<Omit<InstanceDeps, 'instance'>> {
  value?: InstanceValue;
  instance?: InstanceDeps['instance'] & Deps['facts'];
  client?: InMemoryMEditClient;
  adapter?: InstanceAdapter;
  commandsClient?: Parameters<typeof pluginCommandsWith>[1];
}

const SYNCED: PluginSyncRun = () => Promise.resolve({ applied: true, wrote: false, added: [], dropped: [] });

/** The Plugins box in a fresh VS Code, over an instance holding `value` and an mEdit that holds nothing until scripted. */
export function pluginsOver({
  value = instanceValueFixture(), instance = new FakeInstance(value), client = clientHoldingNothing(), adapter = fakeInstanceAdapter().adapter, commandsClient,
  commands = pluginCommandsWith(adapter, commandsClient), syncPlugins = SYNCED, modStatuses = NO_MOD_STATUSES, fileReads = NO_FILE_READS, ...over
}: Over = {}) {
  host.reset();
  const reporters = new Map<string, RecordingReporter>();
  const reporterFor = (tag: string) => {
    const reporter = reporters.get(tag) ?? recordingReporter();
    reporters.set(tag, reporter);
    return reporter;
  };
  const output: string[] = [];
  let revealed = 0;
  const channel = {
    error: (line: string) => { output.push(line); }, info: (line: string) => { output.push(line); }, warn: (line: string) => { output.push(line); },
    show: () => { revealed += 1; },
  };
  const plugins = createPlugins({
    client, facts: instance, channel, reporterFor, registerRepositories: () => Promise.resolve(), ask: scriptedDialog(),
    sourceEditing: { applyWorkspaceChanges: () => Promise.resolve(), oneAtATime: (job) => job(), refreshSourceControlFor: () => undefined },
    ...over,
  });
  const shown = plugins.onInstance({ instance, commands, modStatuses, fileReads, syncPlugins });
  const view = () => host.treeView(PLUGINS_KEY_ARGS.view);
  const rows = async (parent?: unknown) => (await view().treeDataProvider.getChildren(parent)) ?? [];
  const item = async (row: unknown) => await view().treeDataProvider.getTreeItem(row);
  /** The plugin rows the tree shows now, each found by its plugin's name and origin. */
  const pluginRows = async () => {
    const shown = new Map((await rows()).flatMap((row) => { const plugin = pluginArgumentOf(row)?.plugin; return plugin === undefined ? [] : [[pluginAddressKey(plugin), row] as const]; }));
    return (name: string, origin = 'ModA') => shown.get(pluginAddressKey({ name, origin }));
  };
  return {
    client, instance, plugins, shown, reporters, reporter: reporterFor, output, revealed: () => revealed, view, rows, item, pluginRows,
    dispose: () => { shown.dispose(); plugins.dispose(); },
  };
}

/** The plugins of `origin`, ModA unless named, in the order named, each enabled. */
export const pluginsOf = (names: readonly string[], origin = 'ModA') => names.map((name, line) => ({ name, origin, path: `/mods/${origin}/${name}`, line, enabled: true, winning: true }));

type IndexedPlugin = Partial<PluginMetadata> & { name: string; origin: string; enabled?: boolean };
type IndexedOver = Omit<Over, 'value' | 'adapter'> & {
  value?: Partial<InstanceValue>; reading?: Parameters<typeof readingFixture>[0]; answers?: Parameters<typeof fakeInstanceAdapter>[1];
};

/** The Plugins box over `plugins`, each enabled unless it says, which mEdit has indexed as each describes and the
 *  Instance adapter reads in that order, once its status bar says Ready. */
export async function pluginsIndexedOver(plugins: readonly IndexedPlugin[], { value = {}, reading, answers, client = clientHoldingNothing(), ...over }: IndexedOver = {}) {
  client.setQueryAnswer('getPlugins', plugins.map(({ enabled: _enabled, ...plugin }) => pluginMetadataFixture(plugin)));
  client.setQueryAnswer('getPluginsIndexing', []);
  const fake = fakeInstanceAdapter(readingFixture({ pluginOrder: plugins.map(({ name, enabled = true }) => ({ name, enabled })), ...reading }), answers);
  const made = pluginsOver({
    client, adapter: fake.adapter, commandsClient: { getPlugins: () => Promise.resolve([]) }, ...over,
    value: instanceValueFixture({
      activeProfile: 'Default',
      plugins: plugins.map(({ name, origin, enabled = true }, line) => ({ name, origin, path: `/mods/${origin}/${name}`, line, enabled, winning: true })),
      ...value,
    }),
  });
  holdsLoadOrder(client, { indexed: plugins.map(({ name, origin }) => ({ name, origin })) });
  await settled(() => { if (made.plugins.standing.mEdit().length > 0) throw new Error('mEdit is not Ready'); });
  return { ...made, fake, row: await made.pluginRows() };
}

/** The Plugins box over the plugins `names` of `origin`, ModA unless named, as {@link pluginsIndexedOver}. */
export async function indexedOver(names: readonly string[], { origin = 'ModA', ...over }: IndexedOver & { origin?: string } = {}) {
  const made = await pluginsIndexedOver(names.map((name) => ({ name, origin })), over);
  return { ...made, row: (name: string, of = origin) => made.row(name, of) };
}

/** A row of the Plugins view: a line of `origin`, SomeMod unless named, enabled unless it says, or, with `noLine`, a
 *  plugin the game loads with no line. */
export interface Shown { name: string; origin?: string; enabled?: boolean; noLine?: boolean }

/** What mEdit says with a status: the plugins it indexed, those whose read failed, and those whose bytes changed outside. */
interface Told { indexed?: readonly PluginAddress[]; failures?: readonly PluginLoadFailure[]; changedOutside?: readonly PluginAddress[] }

/** What a reconcile mEdit hands over answers: each plugin's facts, and the malformed-plugin scan. */
interface Reconcile extends Told { diagnoses?: PluginDiagnosisReport[] | ReadFailed }

type IndexOfPlugin = Parameters<typeof loadFailuresOf>[0][number];

const settle = () => new Promise((resolve) => setImmediate(resolve));
const SOME_MOD = 'SomeMod';
const addressOf = ({ name, origin = SOME_MOD }: Shown): PluginAddress => ({ name, origin });
const pathOf = ({ name, origin }: PluginAddress) => (origin === 'Data/' ? `/game/Data/${name}` : `/mods/${origin}/${name}`);
const iconOf = (icon: unknown) => (icon instanceof ThemeIcon && icon.id !== 'blank' ? icon.id : undefined);

/** The Plugins box over the rows `shown`, in a found game folder, judging the order by `masterlist` and `userlist`,
 *  with mEdit's facts and record index status as the test tells them. */
export function factsOver(shown: readonly Shown[], { masterlist, userlist, value = {}, ...over }: Omit<Over, 'value' | 'instance'> & {
  masterlist?: string; userlist?: string; value?: Partial<InstanceValue>;
} = {}) {
  const client = over.client ?? clientHoldingNothing();
  client.setQueryAnswer('getPluginsIndexing', []);
  if (over.client === undefined) client.setQueryAnswer('getRecordTypes', []);
  const lines = shown.filter(({ noLine }) => noLine !== true);
  const noLine = shown.filter(({ noLine }) => noLine === true).map(addressOf);
  const origins = [...new Set(shown.map(addressOf).map(({ origin }) => origin))].filter((origin) => origin !== 'Data/' && origin !== 'overwrite/');
  const instance = new FakeInstance(instanceValueFixture({
    gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' },
    mods: origins.map((name) => ({ kind: 'mod' as const, name, enabled: true })),
    plugins: lines.map((plugin, line) => ({ ...addressOf(plugin), path: pathOf(addressOf(plugin)), line, enabled: plugin.enabled ?? true, winning: true })),
    ...noLine.length > 0 && { pluginsLoadedWithNoLine: noLine.map((plugin) => ({ ...plugin, path: pathOf(plugin) })) },
    sortingRuleFiles: {
      ...READ_SORTING_RULE_FILES,
      ...masterlist !== undefined && { masterlist: { path: '/instance/masterlist.yaml', kind: 'text', text: masterlist } },
      ...userlist !== undefined && { userlist: { path: '/instance/userlist.yaml', kind: 'text', text: userlist } },
    },
    ...value,
  }));
  const made = pluginsOver({ ...over, client, instance });
  let version = 0;
  const factsAre = (facts: readonly PluginMetadata[] | ReadFailed) => { client.setQueryAnswer('getPlugins', isReadFailed(facts) ? facts : [...facts]); };
  let indexing: IndexOfPlugin[] = [];
  const outsideAre = (changedOutside: readonly PluginAddress[]) => {
    const outside = (plugin: PluginAddress) => changedOutside.some((changed) => samePluginAddress(changed, plugin));
    client.setQueryAnswer('getPluginsIndexing', [
      ...indexing.map((plugin) => ({ ...plugin, changedOutside: outside(plugin) })),
      ...changedOutside.filter((plugin) => !indexing.some((told) => samePluginAddress(told, plugin)))
        .map(({ name, origin }) => ({ name, origin, state: 'Indexed' as const, changedOutside: true })),
    ]);
  };
  const tell = async (progress: { settled: boolean; refusal?: LoadOrderRefusal }, { indexed = [], failures = [], changedOutside = [] }: Told) => {
    indexing = [
      ...indexed.map(({ name, origin }) => ({ name, origin, state: 'Indexed' as const, changedOutside: false })),
      ...failures.map((failure) => ({ ...failure, state: 'Failed' as const, changedOutside: false })),
    ];
    outsideAre(changedOutside);
    client.setProgress({ done: indexed.length + failures.length, total: shown.length, version: ++version, ...progress });
    if (progress.settled || progress.refusal !== undefined) client.change(undefined);
    await settle();
  };
  const rowOf = async (name: string, origin: string) =>
    (await made.rows()).find((row) => { const plugin = pluginArgumentOf(row)?.plugin; return plugin?.name === name && plugin.origin === origin; });
  const row = async (name: string, origin = SOME_MOD) => {
    const found = await rowOf(name, origin);
    if (found === undefined) return undefined;
    const item = await made.item(found);
    return { description: item.description, icon: iconOf(item.iconPath), tooltip: typeof item.tooltip === 'string' ? item.tooltip.split('\n') : [], context: item.contextValue?.split(' ') ?? [] };
  };
  return {
    ...made, instance,
    /** mEdit hands over a reconcile, each plugin's facts answering `facts`, and the malformed-plugin scan `diagnoses`. */
    reconciled: async (facts: readonly PluginMetadata[] | ReadFailed, { diagnoses = [], indexed = isReadFailed(facts) ? [] : facts, ...told }: Reconcile = {}) => {
      factsAre(facts);
      client.setQueryAnswer('getDiagnoses', diagnoses);
      await tell({ settled: true }, { indexed, ...told });
    },
    /** A tick of a reconcile in progress. */
    indexed: (told: Told = {}) => tell({ settled: false }, told),
    refused: (refusal: LoadOrderRefusal, told: Told = {}) => tell({ settled: false, refusal }, told),
    /** mEdit's change event names `named`, or every plugin, and its facts answer `facts` and whether each changed outside. */
    changed: async (facts: readonly PluginMetadata[] | ReadFailed, named?: readonly PluginAddress[], changedOutside: readonly PluginAddress[] = []) => {
      factsAre(facts);
      outsideAre(changedOutside);
      client.change(named?.map((plugin) => ({ plugin })));
      await settle();
    },
    /** mEdit goes away. */
    unreachable: async () => { client.setStatus('disconnected'); await settle(); },
    /** The row of the plugin, as VS Code draws it; undefined while it has none. */
    row,
    /** The row of the plugin itself, to expand. */
    pluginRow: rowOf,
    /** What the row of the plugin expands into: its records, Still indexing… or the error row's reason. */
    expansion: async (name: string, origin = SOME_MOD) => {
      const [first] = await made.rows(await rowOf(name, origin));
      const item = first === undefined ? undefined : await made.item(first);
      if (item?.contextValue === 'indexing') return { kind: 'indexing' } as const;
      if (item?.contextValue === 'error') return { kind: 'error', message: typeof item.tooltip === 'string' ? item.tooltip : '' } as const;
      return { kind: 'records' } as const;
    },
    /** The view's message line. */
    message: () => made.view().message,
    /** What the row shows of a plugin, the sorting rules and the suggested moves, as the agent reads them. */
    agent: made.shown.pluginsShown,
  };
}
