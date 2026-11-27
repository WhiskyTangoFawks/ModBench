import type * as vscode from 'vscode';
import type {
  CellSummary, ChildRecordSummary, InteriorCellBlock, MEditClient, PluginAddress,
  PluginDiagnosisReport, PluginMetadata, PluginRecordTypeCount, RecordPage, RecordSummary, WorldspaceSummary,
} from '../../client';
import type { ReadFailed } from '../../wire/readFailed';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { pluginMetadataFixture, recordTypeCountFixture } from '../../client/test/fixtures';
import { present } from '../../ports/present';
import { factsOver } from './pluginsOver';

type Answered<T> = Exclude<Awaited<T>, ReadFailed>;
type CellChildRecords = Answered<ReturnType<MEditClient['getCellChildRecords']>>;
export type ContainerChildSummary = Answered<ReturnType<MEditClient['getContainerChildren']>>[number];

type GroupSpec = Partial<PluginRecordTypeCount> & { type: string };

type WorldspaceBlocks = Exclude<Awaited<ReturnType<MEditClient['getWorldspaceBlocks']>>, ReadFailed>;

export interface BrowserAnswers {
  plugins?: PluginMetadata[];
  diagnoses?: PluginDiagnosisReport[];
  recordTypes?: GroupSpec[];
  records?: RecordPage;
  worldspaces?: WorldspaceSummary[];
  worldspaceBlocks?: WorldspaceBlocks;
  interiorCells?: InteriorCellBlock[];
  cellChildRecords?: CellChildRecords;
  containerChildren?: ContainerChildSummary[];
}

/** An mEdit that answers each read of the rows beneath a plugin as `answers` say, and holds nothing else. */
export function browserClient(answers: BrowserAnswers = {}): InMemoryMEditClient {
  const answered: Required<BrowserAnswers> = {
    plugins: [], diagnoses: [], recordTypes: [], records: { items: [], total: 0 }, worldspaces: [],
    worldspaceBlocks: { blocks: [], topCells: [] }, interiorCells: [], cellChildRecords: { persistent: [], temporary: [] }, containerChildren: [],
    ...answers,
  };
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getWorkingTreeStatesBeneath', { plugin: [], recordTypes: {}, records: {} });
  client.setQueryAnswer('getFilterCleared', null);
  client.setQueryAnswer('getPlugins', answered.plugins);
  client.setQueryAnswer('getDiagnoses', answered.diagnoses);
  client.setQueryAnswer('getRecordTypes', answered.recordTypes.map(recordTypeCountFixture));
  client.setQueryAnswer('getRecords', answered.records);
  client.setQueryAnswer('getWorldspaces', answered.worldspaces);
  client.setQueryAnswer('getWorldspaceBlocks', answered.worldspaceBlocks);
  client.setQueryAnswer('getCellChildRecords', answered.cellChildRecords);
  client.setQueryAnswer('getContainerChildren', answered.containerChildren);
  client.setQueryAnswer('getInteriorCells', answered.interiorCells);
  return client;
}

/** A plugin the Plugins view shows, whose records are editable when it says. */
export type Browsed = PluginAddress & { editable?: boolean };

/** The rows the Plugins view shows beneath the rows of `plugins`, once mEdit holds them, over the answers `client` holds. */
export async function browserOver(client: InMemoryMEditClient, plugins: readonly Browsed[]) {
  const facts = factsOver(plugins.map(({ name, origin }) => ({ name, origin })), { client });
  await facts.reconciled(plugins.map(({ editable = false, ...plugin }) => pluginMetadataFixture({ ...plugin, isCompiledPlugin: editable })));
  const itemsOf = async (parent: unknown): Promise<vscode.TreeItem[]> => Promise.all((await facts.rows(parent)).map(facts.item));
  return {
    ...facts,
    /** The rows beneath the plugin's own row. */
    pluginChildren: async (plugin: PluginAddress) => itemsOf(present(await facts.pluginRow(plugin.name, plugin.origin), `the row of ${plugin.name}`)),
    /** The rows beneath `row`. */
    children: (row: vscode.TreeItem) => itemsOf(row),
  };
}

export type Browser = Awaited<ReturnType<typeof browserOver>>;

export async function soleGroup(browser: Browser, plugin: PluginAddress): Promise<vscode.TreeItem> {
  return present((await browser.pluginChildren(plugin))[0], 'the sole group');
}

export async function childrenOf(browser: Browser, row: vscode.TreeItem | undefined, what: string): Promise<vscode.TreeItem[]> {
  return browser.children(present(row, what));
}

export async function soleChild(browser: Browser, row: vscode.TreeItem | undefined, what: string): Promise<vscode.TreeItem> {
  return present((await childrenOf(browser, row, what))[0], `the sole child of ${what}`);
}

async function browse(plugin: Browsed, group: GroupSpec, client: InMemoryMEditClient) {
  client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture(group)]);
  const browser = await browserOver(client, [plugin]);
  return { browser, groupRow: await soleGroup(browser, plugin) };
}

/** The row of `record` in a group of `recordType` beneath `plugin`, over the answers `client` holds. */
export async function recordRow(record: RecordSummary, plugin: Browsed, recordType = 'weap', client = browserClient()) {
  client.setQueryAnswer('getRecords', { items: [record], total: 1 });
  const { browser, groupRow } = await browse(plugin, { type: recordType, count: 1 }, client);
  return { browser, row: await soleChild(browser, groupRow, 'the group row') };
}

async function worldspaceGroup(plugin: Browsed, answer: (client: InMemoryMEditClient) => void) {
  const client = browserClient();
  answer(client);
  const { browser, groupRow } = await browse(plugin, { type: 'wrld', count: 1 }, client);
  return { browser, worldspace: await soleChild(browser, groupRow, 'the worldspace group') };
}

function holdingWorldspace(client: InMemoryMEditClient, plugin: PluginAddress, topCell: CellSummary): void {
  client.setQueryAnswer('getWorldspaces', [{ workingTreeState: 'None', formKey: `w:${plugin.name}`, hasParseFailure: false, hasChildren: true }]);
  client.setQueryAnswer('getWorldspaceBlocks', { topCells: [topCell], blocks: [] });
}

export async function worldspaceRow(worldspace: WorldspaceSummary, plugin: Browsed): Promise<vscode.TreeItem> {
  return (await worldspaceGroup(plugin, (client) => client.setQueryAnswer('getWorldspaces', [worldspace]))).worldspace;
}

export async function cellRow(cell: CellSummary, plugin: Browsed): Promise<vscode.TreeItem> {
  const { browser, worldspace } = await worldspaceGroup(plugin, (client) => holdingWorldspace(client, plugin, cell));
  return soleChild(browser, worldspace, 'the worldspace');
}

export async function placedRow(child: ChildRecordSummary, plugin: Browsed): Promise<vscode.TreeItem> {
  const topCell = { formKey: `c:${plugin.name}`, isPersistentWorldspaceCell: false, hasChildren: true, hasParseFailure: false, workingTreeState: 'None' as const };
  const { browser, worldspace } = await worldspaceGroup(plugin, (client) => {
    holdingWorldspace(client, plugin, topCell);
    client.setQueryAnswer('getCellChildRecords', { persistent: [child], temporary: [] });
  });
  const cell = await soleChild(browser, worldspace, 'the worldspace');
  return soleChild(browser, await soleChild(browser, cell, 'the cell'), 'the placed group');
}
