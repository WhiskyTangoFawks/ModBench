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
import { holdsLoadOrder } from '../../client/test/says';
import { settled } from '../../test/eventually';
import { NO_MOD_STATUSES } from '../../test/noModStatuses';
import { recordingReporter, scriptedDialog, type RecordingReporter } from '../../test/surfacingDoubles';
import { pluginArgumentOf } from '../../drivingLib/argument';
import { pluginAddressKey } from '../../wire/pluginAddress';
import { host } from './vscodeHost';

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

/** The Plugins box over the plugins `names` of `origin`, ModA unless named, which mEdit has indexed and the Instance
 *  adapter reads in that order, once its status bar says Ready. */
export async function indexedOver(names: readonly string[], { value = {}, origin = 'ModA', ...over }: Omit<Over, 'value' | 'client' | 'adapter'> & { value?: Partial<InstanceValue>; origin?: string; reading?: Parameters<typeof readingFixture>[0]; answers?: Parameters<typeof fakeInstanceAdapter>[1] } = {}) {
  const { reading, answers, ...rest } = over;
  const client = clientHoldingNothing();
  client.setQueryAnswer('getPlugins', names.map((name) => pluginMetadataFixture({ name, origin })));
  client.setQueryAnswer('getPluginsIndexing', []);
  const fake = fakeInstanceAdapter(readingFixture({ pluginOrder: names.map((name) => ({ name, enabled: true })), ...reading }), answers);
  const made = pluginsOver({
    client, adapter: fake.adapter, commandsClient: { getPlugins: () => Promise.resolve([]) }, ...rest,
    value: instanceValueFixture({ activeProfile: 'Default', plugins: pluginsOf(names, origin), ...value }),
  });
  holdsLoadOrder(client, { indexed: names.map((name) => ({ name, origin })) });
  await settled(() => { if (made.plugins.standing.mEdit().length > 0) throw new Error('mEdit is not Ready'); });
  const row = await made.pluginRows();
  return { ...made, fake, row: (name: string, of = origin) => row(name, of) };
}
