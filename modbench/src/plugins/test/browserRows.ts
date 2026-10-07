import type {
  CellSummary, ChildRecordSummary, PluginAddress, PluginRecordTypeCount, RecordSummary, WorldspaceSummary,
} from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordTypeCountFixture } from '../../client/test/fixtures';
import { present } from '../../ports/present';
import type { PluginConditions } from '../pluginFacts';
import { PluginTreeProvider, type PluginTreeNode } from '../PluginTreeProvider';

type GroupSpec = Partial<PluginRecordTypeCount> & { type: string };

async function browse(
  plugin: PluginAddress, conditions: PluginConditions | undefined, group: GroupSpec,
  answer: (client: InMemoryMEditClient) => void,
) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture(group)]);
  answer(client);
  const provider = new PluginTreeProvider(client);
  const groupRow = present((await provider.getPluginChildren(plugin, conditions))[0], 'the group row');
  return { provider, groupRow };
}

async function firstChild(provider: PluginTreeProvider, row: PluginTreeNode, what: string): Promise<PluginTreeNode> {
  return present((await provider.getChildren(row))[0], `the first child of ${what}`);
}

export async function recordGroupRow(group: GroupSpec, plugin: PluginAddress, conditions?: PluginConditions): Promise<PluginTreeNode> {
  return (await browse(plugin, conditions, group, () => undefined)).groupRow;
}

export async function recordRow(
  record: RecordSummary, origin: string, conditions?: PluginConditions, recordType = 'weap',
): Promise<PluginTreeNode> {
  const { provider, groupRow } = await browse(
    { name: record.plugin, origin }, conditions, { type: recordType, count: 1 },
    (client) => client.setQueryAnswer('getRecords', { items: [record], total: 1 }),
  );
  return firstChild(provider, groupRow, 'the group row');
}

export async function worldspaceRow(
  worldspace: WorldspaceSummary, plugin: PluginAddress, conditions?: PluginConditions,
): Promise<PluginTreeNode> {
  const { provider, groupRow } = await browse(
    plugin, conditions, { type: 'wrld', count: 1 },
    (client) => client.setQueryAnswer('getWorldspaces', [worldspace]),
  );
  return firstChild(provider, groupRow, 'the worldspace group');
}

export async function cellRow(cell: CellSummary, plugin: PluginAddress, conditions?: PluginConditions): Promise<PluginTreeNode> {
  const { provider, groupRow } = await browse(
    plugin, conditions, { type: 'wrld', count: 1 },
    (client) => {
      client.setQueryAnswer('getWorldspaces', [{ formKey: `w:${plugin.name}`, hasParseFailure: false, hasChildren: true }]);
      client.setQueryAnswer('getWorldspaceBlocks', { topCells: [cell], blocks: [] });
    },
  );
  return firstChild(provider, await firstChild(provider, groupRow, 'the worldspace group'), 'the worldspace');
}

export async function placedRow(child: ChildRecordSummary, plugin: PluginAddress, conditions?: PluginConditions): Promise<PluginTreeNode> {
  const { provider, groupRow } = await browse(
    plugin, conditions, { type: 'wrld', count: 1 },
    (client) => {
      client.setQueryAnswer('getWorldspaces', [{ formKey: `w:${plugin.name}`, hasParseFailure: false, hasChildren: true }]);
      client.setQueryAnswer('getWorldspaceBlocks', {
        topCells: [{ formKey: `c:${plugin.name}`, isPersistentWorldspaceCell: false, hasChildren: true, hasParseFailure: false }], blocks: [],
      });
      client.setQueryAnswer('getCellChildRecords', { persistent: [child], temporary: [] });
    },
  );
  const cell = await firstChild(provider, await firstChild(provider, groupRow, 'the worldspace group'), 'the worldspace');
  return firstChild(provider, await firstChild(provider, cell, 'the cell'), 'the placed group');
}
