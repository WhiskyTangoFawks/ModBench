import type {
  CellChildRecords, CellSummary, ChildRecordSummary, ContainerChildSummary, InteriorCellBlock, MEditClient, PluginAddress,
  PluginDiagnosisReport, PluginMetadata, PluginRecordTypeCount, RecordPage, RecordSummary, WorldspaceSummary,
} from '../../client';
import type { ReadFailed } from '../../wire/readFailed';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordTypeCountFixture } from '../../client/test/fixtures';
import { present } from '../../ports/present';
import type { PluginConditions } from '../../drivingLib/recordRowContext';
import { RecordBrowser, type RecordBrowserNode } from '../RecordBrowser';

export const NOT_EDITABLE: PluginConditions = { editable: false };

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

export function browserClient(answers: BrowserAnswers = {}): InMemoryMEditClient {
  const answered: Required<BrowserAnswers> = {
    plugins: [], diagnoses: [], recordTypes: [], records: { items: [], total: 0 }, worldspaces: [],
    worldspaceBlocks: { blocks: [], topCells: [] }, interiorCells: [], cellChildRecords: { persistent: [], temporary: [] }, containerChildren: [],
    ...answers,
  };
  const client = new InMemoryMEditClient();
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

export interface BrowserOver {
  client: InMemoryMEditClient;
  provider: RecordBrowser;
}

export async function soleGroup(
  provider: RecordBrowser, plugin: PluginAddress, conditions = NOT_EDITABLE,
): Promise<RecordBrowserNode> {
  return present((await provider.getPluginChildren(plugin, conditions))[0], 'the sole group');
}

export async function childrenOf(provider: RecordBrowser, row: RecordBrowserNode | undefined, what: string): Promise<RecordBrowserNode[]> {
  return provider.getChildren(present(row, what));
}

export async function soleChild(provider: RecordBrowser, row: RecordBrowserNode | undefined, what: string): Promise<RecordBrowserNode> {
  return present((await childrenOf(provider, row, what))[0], `the sole child of ${what}`);
}

function freshBrowser(): BrowserOver {
  const client = new InMemoryMEditClient();
  return { client, provider: new RecordBrowser(client) };
}

async function browse(
  plugin: PluginAddress, conditions: PluginConditions | undefined, group: GroupSpec,
  answer: (client: InMemoryMEditClient) => void, over: BrowserOver = freshBrowser(),
) {
  over.client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture(group)]);
  answer(over.client);
  return { provider: over.provider, groupRow: await soleGroup(over.provider, plugin, conditions) };
}

export async function recordGroupRow(group: GroupSpec, plugin: PluginAddress, conditions?: PluginConditions): Promise<RecordBrowserNode> {
  return (await browse(plugin, conditions, group, () => undefined)).groupRow;
}

export async function recordRow(
  record: RecordSummary, origin: string, conditions?: PluginConditions, recordType = 'weap', over?: BrowserOver,
): Promise<RecordBrowserNode> {
  const { provider, groupRow } = await browse(
    { name: record.plugin, origin }, conditions, { type: recordType, count: 1 },
    (client) => client.setQueryAnswer('getRecords', { items: [record], total: 1 }), over,
  );
  return soleChild(provider, groupRow, 'the group row');
}

async function worldspaceGroup(
  plugin: PluginAddress, conditions: PluginConditions | undefined, answer: (client: InMemoryMEditClient) => void,
) {
  const { provider, groupRow } = await browse(plugin, conditions, { type: 'wrld', count: 1 }, answer);
  return { provider, worldspace: await soleChild(provider, groupRow, 'the worldspace group') };
}

function holdingWorldspace(client: InMemoryMEditClient, plugin: PluginAddress, topCell: CellSummary): void {
  client.setQueryAnswer('getWorldspaces', [{ workingTreeState: 'None', formKey: `w:${plugin.name}`, hasParseFailure: false, hasChildren: true }]);
  client.setQueryAnswer('getWorldspaceBlocks', { topCells: [topCell], blocks: [] });
}

export async function worldspaceRow(
  worldspace: WorldspaceSummary, plugin: PluginAddress, conditions?: PluginConditions,
): Promise<RecordBrowserNode> {
  const { provider, groupRow } = await browse(
    plugin, conditions, { type: 'wrld', count: 1 },
    (client) => client.setQueryAnswer('getWorldspaces', [worldspace]),
  );
  return soleChild(provider, groupRow, 'the worldspace group');
}

export async function cellRow(cell: CellSummary, plugin: PluginAddress, conditions?: PluginConditions): Promise<RecordBrowserNode> {
  const { provider, worldspace } = await worldspaceGroup(plugin, conditions, (client) => holdingWorldspace(client, plugin, cell));
  return soleChild(provider, worldspace, 'the worldspace');
}

export async function placedRow(child: ChildRecordSummary, plugin: PluginAddress, conditions?: PluginConditions): Promise<RecordBrowserNode> {
  const topCell = { formKey: `c:${plugin.name}`, isPersistentWorldspaceCell: false, hasChildren: true, hasParseFailure: false, workingTreeState: 'None' as const };
  const { provider, worldspace } = await worldspaceGroup(plugin, conditions, (client) => {
    holdingWorldspace(client, plugin, topCell);
    client.setQueryAnswer('getCellChildRecords', { persistent: [child], temporary: [] });
  });
  const cell = await soleChild(provider, worldspace, 'the worldspace');
  return soleChild(provider, await soleChild(provider, cell, 'the cell'), 'the placed group');
}
