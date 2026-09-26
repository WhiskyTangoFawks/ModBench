import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ TreeItem, TreeItemCollapsibleState }));

import * as vscode from 'vscode';
import { InMemoryMEditClient } from '../../client';
import { selectCreatedRecords } from '../createdRecordSelection';

const NEW_NPC = { plugin: 'MyPatch.esp', origin: 'ModA', recordType: 'npc_', formKey: '000900:MyPatch.esp' };
const OPEN = { command: 'modbench.openEditor', title: 'Open Record', arguments: [{ formKey: NEW_NPC.formKey, label: '000900:MyPatch.esp' }] };

function rowsChanged(keys: string[], plugin = NEW_NPC.plugin, origin = NEW_NPC.origin) {
  return { kind: 'rows-changed', plugin, origin, keys, sequence: 1 };
}

// The Plugins tree as the selection reads it: the row is listed once the tree's own listener to
// the same notification has re-read mEdit.
function harness() {
  const client = new InMemoryMEditClient();
  const row = new vscode.TreeItem('000900:MyPatch.esp');
  row.id = 'the new row';
  row.command = OPEN;
  const tree = { listed: false };
  const seen: string[] = [];
  const selection = selectCreatedRecords({
    subscribe: (kind, listener) => client.subscribe(kind, listener),
    recordRow: (record) => {
      seen.push(`looked up ${record.formKey}`);
      return Promise.resolve(tree.listed && record.formKey === NEW_NPC.formKey ? row : undefined);
    },
    reveal: (revealed, options) => {
      seen.push(`revealed ${revealed.id} ${JSON.stringify(options)}`);
      return Promise.resolve();
    },
    fire: (command, ...args) => {
      seen.push(`fired ${command} ${JSON.stringify(args)}`);
    },
  });
  // Subscribed after the selection, as the record browser's refresh may be.
  client.subscribe('rows-changed', (event) => {
    tree.listed = tree.listed || (event.origin === NEW_NPC.origin && event.keys.includes(NEW_NPC.formKey));
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { client, selection, seen, settle };
}

describe('selectCreatedRecords', () => {
  it('selects the new record\'s row once the watch brings it, then fires open as a click does', async () => {
    const { client, selection, seen, settle } = harness();
    selection.selectWhenListed(NEW_NPC);
    await settle();
    expect(seen).toEqual(['looked up 000900:MyPatch.esp']);

    client.emit(rowsChanged(['000800:MyPatch.esp', NEW_NPC.formKey]));
    await settle();

    expect(seen).toEqual([
      'looked up 000900:MyPatch.esp',
      'looked up 000900:MyPatch.esp',
      'revealed the new row {"select":true,"focus":true}',
      `fired modbench.openEditor ${JSON.stringify(OPEN.arguments)}`,
    ]);
  });

  it('waits past a change that does not name the record, or names it in a plugin of the same name from another origin', async () => {
    const { client, selection, seen, settle } = harness();
    selection.selectWhenListed(NEW_NPC);

    client.emit(rowsChanged(['000800:MyPatch.esp']));
    client.emit(rowsChanged([NEW_NPC.formKey], NEW_NPC.plugin, 'ModB'));
    await settle();
    expect(seen).toEqual(['looked up 000900:MyPatch.esp']);

    client.emit(rowsChanged([NEW_NPC.formKey]));
    await settle();
    expect(seen).toContain(`fired modbench.openEditor ${JSON.stringify(OPEN.arguments)}`);
  });

  it('selects and opens nothing when the row is not shown once the record arrives, and forgets it', async () => {
    const { client, selection, seen, settle } = harness();
    selection.selectWhenListed({ ...NEW_NPC, formKey: '000901:MyPatch.esp' });

    client.emit(rowsChanged(['000901:MyPatch.esp']));
    await settle();
    client.emit(rowsChanged(['000901:MyPatch.esp']));
    await settle();

    expect(seen).toEqual(['looked up 000901:MyPatch.esp', 'looked up 000901:MyPatch.esp']);
  });

  // The watch can bring the record before create's own answer does.
  it('selects a record the watch brought before the view was asked to wait for it', async () => {
    const { client, selection, seen, settle } = harness();
    client.emit(rowsChanged([NEW_NPC.formKey]));

    selection.selectWhenListed(NEW_NPC);
    await settle();

    expect(seen).toEqual([
      'looked up 000900:MyPatch.esp',
      'revealed the new row {"select":true,"focus":true}',
      `fired modbench.openEditor ${JSON.stringify(OPEN.arguments)}`,
    ]);
  });

  it('opens a record it found already listed once, though the watch names it again', async () => {
    const { client, selection, seen, settle } = harness();
    client.emit(rowsChanged([NEW_NPC.formKey]));

    selection.selectWhenListed(NEW_NPC);
    await settle();
    client.emit(rowsChanged([NEW_NPC.formKey]));
    await settle();

    expect(seen).toEqual([
      'looked up 000900:MyPatch.esp',
      'revealed the new row {"select":true,"focus":true}',
      `fired modbench.openEditor ${JSON.stringify(OPEN.arguments)}`,
    ]);
  });

  it('selects only the latest record created', async () => {
    const { client, selection, seen, settle } = harness();
    selection.selectWhenListed({ ...NEW_NPC, formKey: '000800:MyPatch.esp' });
    selection.selectWhenListed(NEW_NPC);

    client.emit(rowsChanged(['000800:MyPatch.esp', NEW_NPC.formKey]));
    await settle();

    expect(seen.filter((line) => line.startsWith('fired'))).toEqual([`fired modbench.openEditor ${JSON.stringify(OPEN.arguments)}`]);
  });

  it('hears nothing once disposed', async () => {
    const { client, selection, seen, settle } = harness();
    selection.selectWhenListed(NEW_NPC);
    await settle();
    selection.dispose();

    client.emit(rowsChanged([NEW_NPC.formKey]));
    await settle();

    expect(seen).toEqual(['looked up 000900:MyPatch.esp']);
  });
});
