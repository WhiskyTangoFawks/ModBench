import type {
  CellSummary, ChildRecordSummary, PluginAddress, PluginRecordTypeCount, RecordSummary, WorldspaceSummary,
} from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordTypeCountFixture } from '../../client/test/fixtures';
import { present } from '../../ports/present';
import type { PluginConditions } from '../pluginFacts';
import { PluginTreeProvider, type PluginTreeNode } from '../PluginTreeProvider';

type GroupSpec = Partial<PluginRecordTypeCount> & { type: string };

export interface BrowserOver {
  client: InMemoryMEditClient;
  provider: PluginTreeProvider;
}

export async function soleGroup(
  provider: PluginTreeProvider, plugin: PluginAddress, conditions?: PluginConditions,
): Promise<PluginTreeNode> {
  return present((await provider.getPluginChildren(plugin, conditions))[0], 'the sole group');
}

export async function childrenOf(provider: PluginTreeProvider, row: PluginTreeNode | undefined, what: string): Promise<PluginTreeNode[]> {
  return provider.getChildren(present(row, what));
}

export async function soleChild(provider: PluginTreeProvider, row: PluginTreeNode | undefined, what: string): Promise<PluginTreeNode> {
  return present((await childrenOf(provider, row, what))[0], `the sole child of ${what}`);
}

function freshBrowser(): BrowserOver {
  const client = new InMemoryMEditClient();
  return { client, provider: new PluginTreeProvider(client) };
}

async function browse(
  plugin: PluginAddress, conditions: PluginConditions | undefined, group: GroupSpec,
  answer: (client: InMemoryMEditClient) => void, over: BrowserOver = freshBrowser(),
) {
  over.client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture(group)]);
  answer(over.client);
  return { provider: over.provider, groupRow: await soleGroup(over.provider, plugin, conditions) };
}

export async function recordGroupRow(group: GroupSpec, plugin: PluginAddress, conditions?: PluginConditions): Promise<PluginTreeNode> {
  return (await browse(plugin, conditions, group, () => undefined)).groupRow;
}

export async function recordRow(
  record: RecordSummary, origin: string, conditions?: PluginConditions, recordType = 'weap', over?: BrowserOver,
): Promise<PluginTreeNode> {
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
  client.setQueryAnswer('getWorldspaces', [{ formKey: `w:${plugin.name}`, hasParseFailure: false, hasChildren: true }]);
  client.setQueryAnswer('getWorldspaceBlocks', { topCells: [topCell], blocks: [] });
}

export async function worldspaceRow(
  worldspace: WorldspaceSummary, plugin: PluginAddress, conditions?: PluginConditions,
): Promise<PluginTreeNode> {
  const { provider, groupRow } = await browse(
    plugin, conditions, { type: 'wrld', count: 1 },
    (client) => client.setQueryAnswer('getWorldspaces', [worldspace]),
  );
  return soleChild(provider, groupRow, 'the worldspace group');
}

export async function cellRow(cell: CellSummary, plugin: PluginAddress, conditions?: PluginConditions): Promise<PluginTreeNode> {
  const { provider, worldspace } = await worldspaceGroup(plugin, conditions, (client) => holdingWorldspace(client, plugin, cell));
  return soleChild(provider, worldspace, 'the worldspace');
}

export async function placedRow(child: ChildRecordSummary, plugin: PluginAddress, conditions?: PluginConditions): Promise<PluginTreeNode> {
  const topCell = { formKey: `c:${plugin.name}`, isPersistentWorldspaceCell: false, hasChildren: true, hasParseFailure: false };
  const { provider, worldspace } = await worldspaceGroup(plugin, conditions, (client) => {
    holdingWorldspace(client, plugin, topCell);
    client.setQueryAnswer('getCellChildRecords', { persistent: [child], temporary: [] });
  });
  const cell = await soleChild(provider, worldspace, 'the worldspace');
  return soleChild(provider, await soleChild(provider, cell, 'the cell'), 'the placed group');
}
