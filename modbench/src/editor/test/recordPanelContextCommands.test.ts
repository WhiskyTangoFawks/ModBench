import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = new Map<string, (ctx?: unknown, option?: unknown) => Promise<void> | void>();
const registerCommand = vi.fn((command: string, handler: (ctx?: unknown, option?: unknown) => Promise<void> | void) => {
  handlers.set(command, handler);
  return { dispose: vi.fn() };
});
const showInputBox = vi.fn<(options: { value?: string }) => Promise<string | undefined>>();
const executeCommand = vi.fn<(command: string, ...args: unknown[]) => Promise<void>>();
const writeText = vi.fn<(text: string) => Promise<void>>();
vi.mock('vscode', () => ({
  commands: {
    registerCommand: (...args: [string, (ctx?: unknown, option?: unknown) => void]) => registerCommand(...args),
    executeCommand: (...args: [string, ...unknown[]]) => executeCommand(...args),
  },
  window: { showInputBox: (options: { value?: string }) => showInputBox(options) },
  env: { clipboard: { writeText: (text: string) => writeText(text) } },
}));

import type { FieldAddress, OpenExtendedFieldEditorParams } from '../extendedFieldEditor';

const openExtendedFieldEditor =
  vi.fn<(params: OpenExtendedFieldEditorParams) => Promise<void>>();

import { commitField, registerRecordPanelContextCommands, type FieldCommitDeps } from '../recordPanelContextCommands';
import type { ArrayElementContext, ArrayParentContext, StringValueContext } from '../../wire/messages';
import { present } from '../../ports/present';

beforeEach(() => { handlers.clear(); registerCommand.mockClear(); openExtendedFieldEditor.mockClear(); showInputBox.mockReset(); executeCommand.mockReset(); writeText.mockReset(); });

type RecordPanelContextCommandDeps = Parameters<typeof registerRecordPanelContextCommands>[0];

const gateSendingEachWriteWhereItWasAddressed: RecordPanelContextCommandDeps['editGateOf'] =
  () => async (address, write) => { await write(address.formKey); };

function makeDeps(overrides: Partial<RecordPanelContextCommandDeps> = {}) {
  const edit = vi.fn<FieldCommitDeps['edit']>(async (_address, _envelope, applied) => { await applied?.(); return undefined; });
  const deps: RecordPanelContextCommandDeps = {
    edit,
    extendedFields: { open: openExtendedFieldEditor },
    editGateOf: gateSendingEachWriteWhereItWasAddressed,
    focusedCell: () => undefined,
    ...overrides,
  };
  return { deps, edit };
}

const IDENTITY = { formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA' };

const ADDRESS = { formKey: IDENTITY.formKey, plugin: { name: IDENTITY.plugin, origin: IDENTITY.origin } };

const editsOf = (edit: ReturnType<typeof makeDeps>['edit']) => edit.mock.calls.map(([address, envelope]) => [address, envelope]);
const envelopesOf = (edit: ReturnType<typeof makeDeps>['edit']) => edit.mock.calls.map(([, envelope]) => envelope);

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
    const { deps, edit } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get(`modbench.record.${command}`), command)(context);

    expect(editsOf(edit)).toEqual([[ADDRESS, envelope]]);
  });

  it('Add lands the value a drop supplies in its add envelope', async () => {
    const { deps, edit } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.addElement'), 'the addElement handler')(
      parentContext([{ kind: 'member', name: 'Values' }]), 6);

    expect(envelopesOf(edit)).toEqual([{ op: 'add', path: [{ kind: 'member', name: 'Values' }], value: 6 }]);
  });

  it('does nothing when a command fires with no context', async () => {
    const { deps, edit } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.addElement'), "the handler registered for 'modbench.record.addElement'")(undefined);

    expect(edit).not.toHaveBeenCalled();
  });
});

const fieldOf = ({ formKey, plugin, origin, path }: StringValueContext): FieldAddress => ({ formKey, plugin: { name: plugin, origin }, path });

describe('right-click edits go through the gate of the panels showing the record, which holds its reads and sends the write to the FormKey the record is at now', () => {
  const movedGate = (gated: string[]): RecordPanelContextCommandDeps['editGateOf'] =>
    () => async (address, write) => { gated.push(address.formKey); await write('000900:Fallout4.esm'); };

  it('a save of the extended editor writes through the gate of the panel it was opened from', async () => {
    const gated: string[] = [];
    const { deps, edit } = makeDeps({ editGateOf: movedGate(gated) });
    registerRecordPanelContextCommands(deps);

    await commitField(deps, fieldOf(stringContext()), 'saved');

    expect(gated).toEqual([IDENTITY.formKey]);
    expect(edit.mock.calls.map(([address]) => address.formKey)).toEqual(['000900:Fallout4.esm']);
  });
});

describe('the extended editor opens and saves from the host, from the context it is handed rather than asking the panel for anything', () => {
  function openedWith(): OpenExtendedFieldEditorParams {
    return present(openExtendedFieldEditor.mock.calls.at(-1), "the last openExtendedFieldEditor call")[0];
  }

  it('opens the tab with the record label and the row\'s own label from the context', async () => {
    const { deps } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.openFieldValue'), "the handler registered for 'modbench.record.openFieldValue'")(stringContext({
      recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Id', readOnly: true,
    }));

    expect(openedWith()).toMatchObject({
      recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Id', formKey: IDENTITY.formKey,
      plugin: IDENTITY.plugin, origin: IDENTITY.origin, readOnly: true,
    });
  });

  it('a save lands one set envelope at the leaf\'s own path', async () => {
    const { deps, edit } = makeDeps();
    registerRecordPanelContextCommands(deps);
    const path = [
      { kind: 'member', name: 'Container' }, { kind: 'index', index: 0 }, { kind: 'member', name: 'Id' },
    ] as StringValueContext['path'];

    await commitField(deps, fieldOf(stringContext({ path })), 'edited in the tab');

    expect(editsOf(edit)).toEqual([[ADDRESS, { op: 'set', path, value: 'edited in the tab' }]]);
  });

  it('a second save of the same tab writes again', async () => {
    const { deps, edit } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await commitField(deps, fieldOf(stringContext()), 'first save');
    await commitField(deps, fieldOf(stringContext()), 'second save');

    expect(envelopesOf(edit).map(({ value }) => value)).toEqual(['first save', 'second save']);
  });
});

describe('a field gesture from the palette, which hands it no cell', () => {
  it('acts on the focused cell of the record tab in focus', async () => {
    const path: ArrayElementContext['path'] = [{ kind: 'member', name: 'Keywords' }, { kind: 'index', index: 1 }];
    const { deps, edit } = makeDeps({ focusedCell: () => elementContext(path) });
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.removeElement'), 'the remove element handler')();

    expect(envelopesOf(edit)).toEqual([{ op: 'remove', path }]);
  });

  it('removes the element a caller addresses by its copy and path, with no panel context', async () => {
    const path: ArrayElementContext['path'] = [{ kind: 'member', name: 'Items' }, { kind: 'index', index: 1 }];
    const { deps, edit } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.removeElement'), 'the remove element handler')({ ...IDENTITY, path });

    expect(editsOf(edit)).toEqual([[ADDRESS, { op: 'remove', path }]]);
  });

  it('does nothing with no focused cell', async () => {
    const { deps, edit } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.removeElement'), 'the remove element handler')();

    expect(edit).not.toHaveBeenCalled();
  });

  it('acts on a cell whose context carries its section beside another, as a string element of an array does', async () => {
    const path: ArrayElementContext['path'] = [{ kind: 'member', name: 'Names' }, { kind: 'index', index: 0 }];
    const { deps, edit } = makeDeps({
      focusedCell: () => ({ ...elementContext(path), webviewSection: 'arrayElement stringValue' }),
    });
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.removeElement'), 'the remove element handler')();

    expect(envelopesOf(edit)).toEqual([{ op: 'remove', path }]);
  });
});

describe('modbench.record.editField, one command for the grid\'s edit and the palette, the grid naming the column\'s (origin, filename) as the Argument', () => {
  const path: ArrayElementContext['path'] = [{ kind: 'member', name: 'Height' }];
  const envelope = { op: 'set' as const, path, value: 0.75 };
  const editField = () => present(handlers.get('modbench.record.editField'), 'the editField handler');

  it('writes the envelope to the plugin copy its Argument names', async () => {
    const { deps, edit } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await editField()(IDENTITY, envelope);

    expect(editsOf(edit)).toEqual([[ADDRESS, envelope]]);
  });

  it('from the palette, asks for the focused string cell\'s new text and sets it at the cell\'s path', async () => {
    showInputBox.mockResolvedValue('a new description');
    const { deps, edit } = makeDeps({ focusedCell: () => stringContext() });
    registerRecordPanelContextCommands(deps);

    await editField()();

    expect(showInputBox).toHaveBeenCalledWith(expect.objectContaining({ value: 'a long description' }));
    expect(editsOf(edit)).toEqual([[
      ADDRESS, { op: 'set', path: [{ kind: 'member', name: 'Description' }], value: 'a new description' },
    ]]);
  });

  it('from the palette, writes nothing when the prompt is dismissed', async () => {
    showInputBox.mockResolvedValue(undefined);
    const { deps, edit } = makeDeps({ focusedCell: () => stringContext() });
    registerRecordPanelContextCommands(deps);

    await editField()();

    expect(edit).not.toHaveBeenCalled();
  });

  it('from the palette, on a cell that is not a string value, writes nothing', async () => {
    const { deps, edit } = makeDeps({ focusedCell: () => parentContext(path) });
    registerRecordPanelContextCommands(deps);

    await editField()();

    expect(showInputBox).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  it('writes nothing for an Argument that is not a record\'s plugin copy', async () => {
    const { deps, edit } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await editField()({ formKey: IDENTITY.formKey }, envelope);

    expect(edit).not.toHaveBeenCalled();
  });
});

describe('modbench.record.openReference', () => {
  function reference() {
    registerRecordPanelContextCommands(makeDeps().deps);
    return present(handlers.get('modbench.record.openReference'), "the handler registered for 'modbench.record.openReference'");
  }

  it('opens the record the clicked reference points to, not the record the panel shows', async () => {
    await reference()({ webviewSection: 'cell reference', ...IDENTITY, referenceTarget: '000F:Fallout4.esm' });
    expect(executeCommand).toHaveBeenCalledWith('modbench.record.open', { argument: { kind: 'record', formKey: '000F:Fallout4.esm' } });
  });

  it('opens nothing from a cell that holds no reference', async () => {
    await reference()({ webviewSection: 'cell', ...IDENTITY });
    expect(executeCommand).not.toHaveBeenCalled();
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
    const { deps, edit } = makeDeps({ focusedCell: () => editableCell(true) });
    registerRecordPanelContextCommands(deps);

    await cut()();

    expect(writeText.mock.calls).toEqual([['7']]);
    expect(envelopesOf(edit)).toEqual([{ op: 'set', path: LEVEL, value: null }]);
  });

  it('copies an element and removes it, in one edit', async () => {
    const element = { ...editableCell(true), webviewSection: 'cell arrayElement editableCell', copyText: '4', path: ELEMENT };
    const { deps, edit } = makeDeps({ focusedCell: () => element });
    registerRecordPanelContextCommands(deps);

    await cut()();

    expect(writeText.mock.calls).toEqual([['4']]);
    expect(envelopesOf(edit)).toEqual([{ op: 'remove', path: ELEMENT }]);
  });

  it('leaves the clipboard as it was when the edit is refused', async () => {
    const refusing = vi.fn<FieldCommitDeps['edit']>(() => Promise.resolve(undefined));
    const { deps } = makeDeps({ focusedCell: () => editableCell(true), edit: refusing });
    registerRecordPanelContextCommands(deps);

    await cut()();

    expect(refusing).toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([
    ['a field the plugin does not hold', editableCell(false)],
    ['a cell that cannot be edited', { webviewSection: 'cell', copyText: '7' }],
    ['no focused cell', undefined],
  ])('copies nothing and edits nothing on %s', async (_what, cell) => {
    const { deps, edit } = makeDeps({ focusedCell: () => cell });
    registerRecordPanelContextCommands(deps);

    await cut()();

    expect(writeText).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });
});
