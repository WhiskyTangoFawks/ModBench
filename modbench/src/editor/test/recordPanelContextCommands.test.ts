import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clipboard, commandHandlers as handlers, editorVscode, executed, showInputBox, showTextDocument } from './editorVscode';

vi.mock('vscode', () => editorVscode);

import type { RecordEditChangesOutcome } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { WEBVIEW_TO_EXTENSION, type ArrayElementContext, type ArrayParentContext, type StringValueContext } from '../../wire/messages';
import { present } from '../../ports/present';
import { editAnswered, editorOver, forgetEditor } from './editorHarness';

beforeEach(forgetEditor);

function focusedOn({ focusedCell = null, edits = editAnswered() }: { focusedCell?: unknown; edits?: RecordEditChangesOutcome } = {}) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: '/source/ModA/plugin-source/MyMod.esp/Npc.json' });
  client.setQueryAnswer('getEditChanges', edits);
  const { open } = editorOver({ meditClient: client });
  open('000801:A.esp').receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: focusedCell, entered: true });
  return { client };
}

const IDENTITY = { formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA' };

const ADDRESS = { formKey: IDENTITY.formKey, plugin: { name: IDENTITY.plugin, origin: IDENTITY.origin } };

const editsAsked = (client: InMemoryMEditClient) => client.calls.filter(({ method }) => method === 'getEditChanges').map(({ args }) => args);
const editsOf = (client: InMemoryMEditClient) => editsAsked(client).map(([formKey, plugin, envelope]) => [{ formKey, plugin }, envelope]);
const envelopesOf = (client: InMemoryMEditClient) => editsAsked(client).map(([, , envelope]) => envelope);

function parentContext(path: ArrayParentContext['path']): ArrayParentContext {
  return { webviewSection: 'arrayParent', ...IDENTITY, path, preventDefaultContextMenuItems: true };
}

function stringContext(overrides: Partial<StringValueContext> = {}): StringValueContext {
  return {
    webviewSection: 'stringValue', ...IDENTITY,
    recordLabel: 'TestNPC [000001:Fallout4.esm]', fieldName: 'Description', value: 'a long description',
    readOnly: false, path: [{ kind: 'member', name: 'Description' }],
    preventDefaultContextMenuItems: true, ...overrides,
  };
}

function elementContext(path: ArrayElementContext['path']): ArrayElementContext {
  return {
    webviewSection: 'arrayElement', ...IDENTITY, path,
    canMoveUp: true, canMoveDown: true, preventDefaultContextMenuItems: true,
  };
}

describe('right-click array ops write one envelope from the host', () => {
  const CONTAINER_ENTRIES = [{ kind: 'member', name: 'Container' }, { kind: 'member', name: 'Entries' }] as const;
  const THIRD_ENTRY = [...CONTAINER_ENTRIES, { kind: 'index', index: 2 }] as const;
  const FIRST_VALUE = [{ kind: 'member', name: 'Values' }, { kind: 'index', index: 0 }] as const;
  const SECOND_SCRIPT = [{ kind: 'member', name: 'Scripts' }, { kind: 'index', index: 1 }] as const;

  it.each([
    ['Add lands an add envelope at a nested array\'s own path', 'addElement', parentContext([...CONTAINER_ENTRIES]),
      { op: 'add', path: CONTAINER_ENTRIES }],
    ['Remove lands a remove envelope at the element\'s own path', 'removeElement', elementContext([...SECOND_SCRIPT]),
      { op: 'remove', path: SECOND_SCRIPT }],
    ['Move Up lands a move envelope to the position before it', 'moveElementUp', elementContext([...THIRD_ENTRY]),
      { op: 'move', path: THIRD_ENTRY, value: 1 }],
    ['Move Down lands a move envelope to the position after it', 'moveElementDown', elementContext([...THIRD_ENTRY]),
      { op: 'move', path: THIRD_ENTRY, value: 3 }],
    ['Move Up on the first element still lands the move, to the position before it, since the webview posts what the user asked for',
      'moveElementUp', elementContext([...FIRST_VALUE]), { op: 'move', path: FIRST_VALUE, value: -1 }],
  ])('%s', async (_, command, context, envelope) => {
    const { client } = focusedOn();

    await present(handlers.get(`modbench.record.${command}`), command)(context);

    expect(editsOf(client)).toEqual([[ADDRESS, envelope]]);
  });

  it('Add lands the value a drop supplies in its add envelope', async () => {
    const { client } = focusedOn();

    await present(handlers.get('modbench.record.addElement'), 'the addElement handler')(
      parentContext([{ kind: 'member', name: 'Values' }]), 6);

    expect(envelopesOf(client)).toEqual([{ op: 'add', path: [{ kind: 'member', name: 'Values' }], value: 6 }]);
  });

  it('does nothing when a command fires with no context', async () => {
    const { client } = focusedOn();

    await present(handlers.get('modbench.record.addElement'), "the handler registered for 'modbench.record.addElement'")(undefined);

    expect(editsAsked(client)).toEqual([]);
  });
});

describe('the extended editor opens from the host, from the context it is handed rather than asking the panel for anything', () => {
  it('opens the tab with the record label and the row\'s own label from the context', async () => {
    focusedOn();

    await present(handlers.get('modbench.record.openFieldValue'), "the handler registered for 'modbench.record.openFieldValue'")(stringContext({
      recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Id', readOnly: true,
    }));

    expect(showTextDocument.mock.calls.map(([document]) => String(document.uri))).toEqual([
      `modbench-field-readonly:/Deacon [000123:Fallout4.esm]/Id [MyMod.esp]?${JSON.stringify({ formKey: IDENTITY.formKey, plugin: ADDRESS.plugin, path: [{ kind: 'member', name: 'Description' }] })}`,
    ]);
  });
});

describe('a field gesture from the palette, which hands it no cell', () => {
  it('acts on the focused cell of the record tab in focus', async () => {
    const path: ArrayElementContext['path'] = [{ kind: 'member', name: 'Keywords' }, { kind: 'index', index: 1 }];
    const { client } = focusedOn({ focusedCell: elementContext(path) });

    await present(handlers.get('modbench.record.removeElement'), 'the remove element handler')();

    expect(envelopesOf(client)).toEqual([{ op: 'remove', path }]);
  });

  it('removes the element a caller addresses by its copy and path, with no panel context', async () => {
    const path: ArrayElementContext['path'] = [{ kind: 'member', name: 'Items' }, { kind: 'index', index: 1 }];
    const { client } = focusedOn();

    await present(handlers.get('modbench.record.removeElement'), 'the remove element handler')({ ...IDENTITY, path });

    expect(editsOf(client)).toEqual([[ADDRESS, { op: 'remove', path }]]);
  });

  it('does nothing with no focused cell', async () => {
    const { client } = focusedOn();

    await present(handlers.get('modbench.record.removeElement'), 'the remove element handler')();

    expect(editsAsked(client)).toEqual([]);
  });

  it('acts on a cell whose context carries its section beside another, as a string element of an array does', async () => {
    const path: ArrayElementContext['path'] = [{ kind: 'member', name: 'Names' }, { kind: 'index', index: 0 }];
    const { client } = focusedOn({
      focusedCell: { ...elementContext(path), webviewSection: 'arrayElement stringValue' },
    });

    await present(handlers.get('modbench.record.removeElement'), 'the remove element handler')();

    expect(envelopesOf(client)).toEqual([{ op: 'remove', path }]);
  });
});

describe('modbench.record.editField, one command for the grid\'s edit and the palette, the grid naming the column\'s (origin, filename) as the Argument', () => {
  const path: ArrayElementContext['path'] = [{ kind: 'member', name: 'Height' }];
  const envelope = { op: 'set' as const, path, value: 0.75 };
  const editField = () => present(handlers.get('modbench.record.editField'), 'the editField handler');

  it('writes the envelope to the plugin copy its Argument names', async () => {
    const { client } = focusedOn();

    await editField()(IDENTITY, envelope);

    expect(editsOf(client)).toEqual([[ADDRESS, envelope]]);
  });

  it('from the palette, asks for the focused string cell\'s new text and sets it at the cell\'s path', async () => {
    showInputBox.mockResolvedValue('a new description');
    const { client } = focusedOn({ focusedCell: stringContext() });

    await editField()();

    expect(showInputBox).toHaveBeenCalledWith(expect.objectContaining({ value: 'a long description' }));
    expect(editsOf(client)).toEqual([[
      ADDRESS, { op: 'set', path: [{ kind: 'member', name: 'Description' }], value: 'a new description' },
    ]]);
  });

  it('from the palette, writes nothing when the prompt is dismissed', async () => {
    showInputBox.mockResolvedValue(undefined);
    const { client } = focusedOn({ focusedCell: stringContext() });

    await editField()();

    expect(editsAsked(client)).toEqual([]);
  });

  it('from the palette, on a cell that is not a string value, writes nothing', async () => {
    const { client } = focusedOn({ focusedCell: parentContext(path) });

    await editField()();

    expect(showInputBox).not.toHaveBeenCalled();
    expect(editsAsked(client)).toEqual([]);
  });

  it('writes nothing for an Argument that is not a record\'s plugin copy', async () => {
    const { client } = focusedOn();

    await editField()({ formKey: IDENTITY.formKey }, envelope);

    expect(editsAsked(client)).toEqual([]);
  });
});

describe('modbench.record.openReference', () => {
  function reference() {
    focusedOn();
    handlers.set('modbench.record.open', () => undefined);
    return present(handlers.get('modbench.record.openReference'), "the handler registered for 'modbench.record.openReference'");
  }

  it('opens the record the clicked reference points to, not the record the panel shows', async () => {
    await reference()({ webviewSection: 'cell reference', ...IDENTITY, referenceTarget: '000F:Fallout4.esm' });
    expect(executed()).toContainEqual(['modbench.record.open', { argument: { kind: 'record', formKey: '000F:Fallout4.esm' } }]);
  });

  it('opens nothing from a cell that holds no reference', async () => {
    await reference()({ webviewSection: 'cell', ...IDENTITY });
    expect(executed()).toEqual([]);
  });
});

describe('modbench.record.cut, the focused cell\'s value copied and removed in one edit', () => {
  const LEVEL: ArrayElementContext['path'] = [{ kind: 'member', name: 'Level' }];
  const ELEMENT: ArrayElementContext['path'] = [{ kind: 'member', name: 'Values' }, { kind: 'index', index: 0 }];
  const editableCell = (holdsValue: boolean) => ({
    webviewSection: 'cell editableCell', copyText: '7', ...IDENTITY, path: LEVEL, holdsValue,
  });
  const cut = () => present(handlers.get('modbench.record.cut'), 'the cut handler');

  it('copies a field\'s value and sets the field to nothing, in one edit', async () => {
    const { client } = focusedOn({ focusedCell: editableCell(true) });

    await cut()();

    expect(clipboard.writeText.mock.calls).toEqual([['7']]);
    expect(envelopesOf(client)).toEqual([{ op: 'set', path: LEVEL, value: null }]);
  });

  it('copies an element and removes it, in one edit', async () => {
    const element = { ...editableCell(true), webviewSection: 'cell arrayElement editableCell', copyText: '4', path: ELEMENT };
    const { client } = focusedOn({ focusedCell: element });

    await cut()();

    expect(clipboard.writeText.mock.calls).toEqual([['4']]);
    expect(envelopesOf(client)).toEqual([{ op: 'remove', path: ELEMENT }]);
  });

  it('leaves the clipboard as it was when the edit is refused', async () => {
    const { client } = focusedOn({ focusedCell: editableCell(true), edits: { applied: false, refusal: 'ReadOnly', message: 'Read-only.' } });

    await cut()();

    expect(editsAsked(client)).toHaveLength(1);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it.each([
    ['a field the plugin does not hold', editableCell(false)],
    ['a cell that cannot be edited', { webviewSection: 'cell', copyText: '7' }],
    ['no focused cell', undefined],
  ])('copies nothing and edits nothing on %s', async (_what, cell) => {
    const { client } = focusedOn({ focusedCell: cell });

    await cut()();

    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(editsAsked(client)).toEqual([]);
  });
});
