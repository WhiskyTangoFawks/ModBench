import { describe, it, expect, vi } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordTypeCountFixture } from '../../client/test/fixtures';
import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, uriFrom } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, Uri: { from: uriFrom },
}));

import { soleChild, soleGroup } from './browserRows';
import { PluginTreeProvider, type PluginTreeNode } from '../PluginTreeProvider';
import { RecordDecorationProvider } from '../RecordDecorationProvider';
import type { PluginAddress } from '../../wire/pluginAddress';
import { present } from '../../ports/present';

const PLUGIN: PluginAddress = { name: 'Plugin0.esp', origin: 'Data' };

function badgeOf(provider: PluginTreeProvider, row: PluginTreeNode): string | undefined {
  const badges = new RecordDecorationProvider(provider);
  return badges.provideFileDecoration(present(row.resourceUri, 'the row\'s resourceUri'))?.badge;
}

async function groupOf(client: InMemoryMEditClient, type: string) {
  client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type, count: 1 })]);
  const provider = new PluginTreeProvider(client);
  return { provider, group: await soleGroup(provider, PLUGIN) };
}

describe('the working-tree badge of worldspace, cell and placed reference rows', () => {
  it('shows M on a modified worldspace, A on an added exterior cell and M on a modified placed reference', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorldspaces', [{ formKey: 'w:Plugin0.esp', hasParseFailure: false, hasChildren: true, workingTreeState: 'Modified' }]);
    client.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [],
      blocks: [{
        x: 0, y: 0, hasParseFailure: false,
        subBlocks: [{ x: 0, y: 0, hasParseFailure: false, cells: [
          { formKey: 'c:Plugin0.esp', isPersistentWorldspaceCell: false, hasChildren: true, hasParseFailure: false, workingTreeState: 'Added' },
        ] }],
      }],
    });
    client.setQueryAnswer('getCellChildRecords', {
      persistent: [{ formKey: 'r:Plugin0.esp', recordType: 'refr', hasParseFailure: false, workingTreeState: 'Modified' }], temporary: [],
    });
    const { provider, group } = await groupOf(client, 'wrld');

    const worldspace = await soleChild(provider, group, 'the group');
    const block = await soleChild(provider, worldspace, 'the worldspace');
    const subBlock = await soleChild(provider, block, 'the block');
    const cell = await soleChild(provider, subBlock, 'the sub-block');
    const placed = await soleChild(provider, await soleChild(provider, cell, 'the cell'), 'the placed group');

    expect([badgeOf(provider, worldspace), badgeOf(provider, cell), badgeOf(provider, placed)]).toEqual(['M', 'A', 'M']);
  });

  it('shows M on a modified interior cell', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getInteriorCells', [{ number: 0, hasParseFailure: false, subBlocks: [{ number: 0, hasParseFailure: false, cells: [
      { formKey: 'i:Plugin0.esp', hasChildren: false, hasParseFailure: false, workingTreeState: 'Modified' },
    ] }] }]);
    const { provider, group } = await groupOf(client, 'cell');

    const block = await soleChild(provider, group, 'the group');
    const cell = await soleChild(provider, await soleChild(provider, block, 'the block'), 'the sub-block');

    expect(badgeOf(provider, cell)).toBe('M');
  });

  it('shows no badge on a clean row', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorldspaces', [{ formKey: 'w:Plugin0.esp', hasParseFailure: false, hasChildren: false, workingTreeState: 'None' }]);
    const { provider, group } = await groupOf(client, 'wrld');

    expect(badgeOf(provider, await soleChild(provider, group, 'the group'))).toBeUndefined();
  });

  it('names a row it reads, so a decoration VS Code holds is refreshed', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorldspaces', [{ formKey: 'w:Plugin0.esp', hasParseFailure: false, hasChildren: false, workingTreeState: 'Modified' }]);
    const { provider, group } = await groupOf(client, 'wrld');
    const read: (readonly unknown[])[] = [];
    provider.onDidReadRecords((uris) => read.push(uris));

    const worldspace = await soleChild(provider, group, 'the group');

    expect(read).toEqual([[worldspace.resourceUri]]);
  });
});
