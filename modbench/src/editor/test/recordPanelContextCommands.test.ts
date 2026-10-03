import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = new Map<string, (ctx?: unknown, option?: unknown) => Promise<void> | void>();
const registerCommand = vi.fn((command: string, handler: (ctx?: unknown, option?: unknown) => Promise<void> | void) => {
  handlers.set(command, handler);
  return { dispose: vi.fn() };
});
const showInputBox = vi.fn<(options: { value?: string }) => Promise<string | undefined>>();
const executeCommand = vi.fn<(command: string, ...args: unknown[]) => Promise<void>>();
vi.mock('vscode', () => ({
  commands: {
    registerCommand: (...args: [string, (ctx?: unknown, option?: unknown) => void]) => registerCommand(...args),
    executeCommand: (...args: [string, ...unknown[]]) => executeCommand(...args),
  },
  window: { showInputBox: (options: { value?: string }) => showInputBox(options) },
}));

import type { ExtendedFieldEditorDeps, OpenExtendedFieldEditorParams } from '../extendedFieldEditor';

const openExtendedFieldEditor =
  vi.fn<(params: OpenExtendedFieldEditorParams, deps: ExtendedFieldEditorDeps) => Promise<void>>();
vi.mock('../extendedFieldEditor', () => ({
  openExtendedFieldEditor: (...args: [OpenExtendedFieldEditorParams, ExtendedFieldEditorDeps]) =>
    openExtendedFieldEditor(...args),
}));

import { registerRecordPanelContextCommands, type RecordPanelContextCommandDeps } from '../recordPanelContextCommands';
import { EXTENSION_TO_WEBVIEW, type ArrayElementContext, type ArrayParentContext, type ExtensionToWebview, type StringValueContext } from '../../wire/messages';
import { InMemoryMEditClient } from '../../client';
import { present } from '../../ports/present';

beforeEach(() => { handlers.clear(); registerCommand.mockClear(); openExtendedFieldEditor.mockClear(); showInputBox.mockReset(); executeCommand.mockReset(); });

const gateSendingEachWriteWhereItWasAddressed: RecordPanelContextCommandDeps['editGateOf'] =
  () => async (address, write) => { await write(address.formKey); };

function makeDeps(overrides: Partial<RecordPanelContextCommandDeps> = {}) {
  const meditClient = new InMemoryMEditClient();
  meditClient.setCommandResult('editRecord', { applied: true });
  const refreshSourceControlFor = vi.fn();
  const report = vi.fn();
  const tellPanels = vi.fn<(message: ExtensionToWebview) => void>();
  const deps: RecordPanelContextCommandDeps = {
    meditClient,
    refreshSourceControlFor,
    tellPanels,
    reporter: { report, landed: vi.fn(), insideDialog: vi.fn(), selectionOutcome: vi.fn() },
    fieldFile: () => ({ folder: '/tmp/does-not-open-here', file: '/tmp/does-not-open-here/field.txt' }),
    log: vi.fn(),
    editGateOf: gateSendingEachWriteWhereItWasAddressed,
    focusedCell: () => undefined,
    ...overrides,
  };
  return { deps, meditClient, refreshSourceControlFor, report, tellPanels };
}

const IDENTITY = { formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA' };

function editRecordCalls(client: InMemoryMEditClient) {
  return client.calls.filter(c => c.method === 'editRecord');
}

function envelopeValueNarrowedFromUnknownCallArgs(args: unknown[]): string {
  const envelope = args[3];
  const value: unknown = typeof envelope === 'object' && envelope !== null ? Reflect.get(envelope, 'value') : undefined;
  if (typeof value !== 'string') throw new Error('expected an editRecord envelope carrying a string value');
  return value;
}

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
  it('Add lands an add envelope at a nested array\'s own path', async () => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.addElement'), "the handler registered for 'modbench.record.addElement'")(parentContext(
      [{ kind: 'member', name: 'Container' }, { kind: 'member', name: 'Entries' }],
    ));

    expect(editRecordCalls(meditClient)).toHaveLength(1);
    expect(present(editRecordCalls(meditClient)[0], "the sole editRecord call").args).toEqual([
      IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin,
      { op: 'add', path: [{ kind: 'member', name: 'Container' }, { kind: 'member', name: 'Entries' }] },
    ]);
  });

  it('Add lands the value a drop supplies in its add envelope', async () => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.addElement'), 'the addElement handler')(
      parentContext([{ kind: 'member', name: 'Values' }]), 6);

    expect(present(editRecordCalls(meditClient)[0], 'the sole editRecord call').args[3])
      .toEqual({ op: 'add', path: [{ kind: 'member', name: 'Values' }], value: 6 });
  });

  it('Remove lands a remove envelope at the element\'s own path', async () => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.removeElement'), "the handler registered for 'modbench.record.removeElement'")(elementContext(
      [{ kind: 'member', name: 'Scripts' }, { kind: 'index', index: 1 }],
    ));

    expect(present(editRecordCalls(meditClient)[0], "the sole editRecord call").args).toEqual([
      IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin,
      { op: 'remove', path: [{ kind: 'member', name: 'Scripts' }, { kind: 'index', index: 1 }] },
    ]);
  });

  it.each([
    ['modbench.record.moveElementUp', 1],
    ['modbench.record.moveElementDown', 3],
  ] as const)('%s lands a move envelope carrying the neighbour position', async (command, destination) => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get(command), "the handler registered for the command under test")(elementContext(
      [{ kind: 'member', name: 'Container' }, { kind: 'member', name: 'Entries' }, { kind: 'index', index: 2 }],
    ));

    expect(present(editRecordCalls(meditClient)[0], "the sole editRecord call").args).toEqual([
      IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin,
      {
        op: 'move',
        path: [{ kind: 'member', name: 'Container' }, { kind: 'member', name: 'Entries' }, { kind: 'index', index: 2 }],
        value: destination,
      },
    ]);
  });

  it('Move Up on the first element still lands the move, to the position before it, since the webview posts what the user asked for', async () => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.moveElementUp'), "the handler registered for 'modbench.record.moveElementUp'")(elementContext([{ kind: 'member', name: 'Values' }, { kind: 'index', index: 0 }]));

    expect(present(editRecordCalls(meditClient)[0], "the sole editRecord call").args).toEqual([
      IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin,
      { op: 'move', path: [{ kind: 'member', name: 'Values' }, { kind: 'index', index: 0 }], value: -1 },
    ]);
  });

  it('tells the panel to re-read once the edit has landed', async () => {
    const { deps, refreshSourceControlFor } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.addElement'), "the handler registered for 'modbench.record.addElement'")(parentContext([{ kind: 'member', name: 'Values' }]));

    expect(refreshSourceControlFor).toHaveBeenCalledWith(IDENTITY.plugin, IDENTITY.origin);
  });

  it('surfaces a refusal as a warning and does not re-read', async () => {
    const { deps, meditClient, refreshSourceControlFor, report } = makeDeps();
    meditClient.setCommandResult('editRecord', { applied: false, refusal: 'NotTracked', message: 'Track the mod first.' });
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.addElement'), "the handler registered for 'modbench.record.addElement'")(parentContext([{ kind: 'member', name: 'Values' }]));

    expect(report).toHaveBeenCalledWith('warning', 'Track the mod first.');
    expect(refreshSourceControlFor).not.toHaveBeenCalled();
  });

  it('does nothing when a command fires with no context', async () => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.addElement'), "the handler registered for 'modbench.record.addElement'")(undefined);

    expect(editRecordCalls(meditClient)).toHaveLength(0);
  });
});

describe('right-click edits go through the gate of the panels showing the record, which holds its reads and sends the write to the FormKey the record is at now', () => {
  const movedGate = (gated: string[]): RecordPanelContextCommandDeps['editGateOf'] =>
    () => async (address, write) => { gated.push(address.formKey); await write('000900:Fallout4.esm'); };

  it('an array op writes through the gate', async () => {
    const gated: string[] = [];
    const { deps, meditClient } = makeDeps({ editGateOf: movedGate(gated) });
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.addElement'), 'the addElement handler')(
      parentContext([{ kind: 'member', name: 'Entries' }]));

    expect(gated).toEqual([IDENTITY.formKey]);
    expect(editRecordCalls(meditClient).map(c => c.args[0])).toEqual(['000900:Fallout4.esm']);
  });

  it('takes the gate of the panels showing the record it is addressed to', async () => {
    const asked: string[] = [];
    const { deps } = makeDeps({ editGateOf: address => { asked.push(address.formKey); return async (address, write) => { await write(address.formKey); }; } });
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.addElement'), 'the addElement handler')(
      parentContext([{ kind: 'member', name: 'Entries' }]));

    expect(asked).toEqual([IDENTITY.formKey]);
  });

  it('a save of the extended editor writes through the gate of the panel it was opened from', async () => {
    const gated: string[] = [];
    const { deps, meditClient } = makeDeps({ editGateOf: movedGate(gated) });
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.openFieldValue'), 'the openFieldValue handler')(stringContext());
    const [, editorDeps] = present(openExtendedFieldEditor.mock.calls.at(-1), 'the openExtendedFieldEditor call');
    await editorDeps.onCommit('saved');

    expect(gated).toEqual([IDENTITY.formKey]);
    expect(editRecordCalls(meditClient).map(c => c.args[0])).toEqual(['000900:Fallout4.esm']);
  });
});

describe('the extended editor opens and saves from the host, from the context it is handed rather than asking the panel for anything', () => {
  function openedWith(): { params: OpenExtendedFieldEditorParams; deps: ExtendedFieldEditorDeps } {
    const [params, editorDeps] = present(openExtendedFieldEditor.mock.calls.at(-1), "the last openExtendedFieldEditor call");
    return { params, deps: editorDeps };
  }

  it('opens the tab with the record label and the row\'s own label from the context', async () => {
    const { deps } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.openFieldValue'), "the handler registered for 'modbench.record.openFieldValue'")(stringContext({
      recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Id', readOnly: true,
    }));

    expect(openedWith().params).toEqual({
      value: 'a long description', recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Id',
      plugin: IDENTITY.plugin, origin: IDENTITY.origin, readOnly: true,
    });
  });

  it('a save lands one set envelope at the leaf\'s own path, and re-reads', async () => {
    const { deps, meditClient, refreshSourceControlFor } = makeDeps();
    registerRecordPanelContextCommands(deps);
    const path = [
      { kind: 'member', name: 'Container' }, { kind: 'index', index: 0 }, { kind: 'member', name: 'Id' },
    ] as StringValueContext['path'];

    await present(handlers.get('modbench.record.openFieldValue'), "the handler registered for 'modbench.record.openFieldValue'")(stringContext({ path }));
    await openedWith().deps.onCommit('edited in the tab');

    expect(present(editRecordCalls(meditClient)[0], "the sole editRecord call").args).toEqual([
      IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin,
      { op: 'set', path, value: 'edited in the tab' },
    ]);
    expect(refreshSourceControlFor).toHaveBeenCalledWith(IDENTITY.plugin, IDENTITY.origin);
  });

  it('a second save of the same tab writes again', async () => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.openFieldValue'), "the handler registered for 'modbench.record.openFieldValue'")(stringContext());
    await openedWith().deps.onCommit('first save');
    await openedWith().deps.onCommit('second save');

    expect(editRecordCalls(meditClient).map(c => envelopeValueNarrowedFromUnknownCallArgs(c.args))).toEqual(['first save', 'second save']);
  });
});

describe('a field gesture from the palette, which hands it no cell', () => {
  it('acts on the focused cell of the record tab in focus', async () => {
    const path: ArrayElementContext['path'] = [{ kind: 'member', name: 'Keywords' }, { kind: 'index', index: 1 }];
    const { deps, meditClient } = makeDeps({ focusedCell: () => elementContext(path) });
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.removeElement'), 'the remove element handler')();

    expect(editRecordCalls(meditClient).map(c => c.args[3])).toEqual([{ op: 'remove', path }]);
  });

  it('does nothing with no focused cell', async () => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.removeElement'), 'the remove element handler')();

    expect(editRecordCalls(meditClient)).toEqual([]);
  });

  it('acts on a cell whose context carries its section beside another, as a string element of an array does', async () => {
    const path: ArrayElementContext['path'] = [{ kind: 'member', name: 'Names' }, { kind: 'index', index: 0 }];
    const { deps, meditClient } = makeDeps({
      focusedCell: () => ({ ...elementContext(path), webviewSection: 'arrayElement stringValue' }),
    });
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.removeElement'), 'the remove element handler')();

    expect(editRecordCalls(meditClient).map(c => c.args[3])).toEqual([{ op: 'remove', path }]);
  });
});

describe('modbench.record.editField, one command for the grid\'s edit and the palette, the grid naming the column\'s (origin, filename) as the Argument', () => {
  const path: ArrayElementContext['path'] = [{ kind: 'member', name: 'Height' }];
  const envelope = { op: 'set' as const, path, value: 0.75 };
  const editField = () => present(handlers.get('modbench.record.editField'), 'the editField handler');

  it('writes the envelope to the plugin copy its Argument names', async () => {
    const { deps, meditClient, refreshSourceControlFor } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await editField()(IDENTITY, envelope);

    expect(editRecordCalls(meditClient).map(c => c.args)).toEqual([[IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin, envelope]]);
    expect(refreshSourceControlFor).toHaveBeenCalledWith(IDENTITY.plugin, IDENTITY.origin);
  });

  it('goes through the gate of the panels showing the record its Argument names', async () => {
    const asked: string[] = [];
    const { deps } = makeDeps({ editGateOf: address => { asked.push(address.formKey); return async (address, write) => { await write(address.formKey); }; } });
    registerRecordPanelContextCommands(deps);

    await editField()(IDENTITY, envelope);

    expect(asked).toEqual([IDENTITY.formKey]);
  });

  it('surfaces a refusal as a warning, and re-reads nothing', async () => {
    const { deps, meditClient, refreshSourceControlFor, report } = makeDeps();
    meditClient.setCommandResult('editRecord', { applied: false, refusal: 'NotTracked', message: 'Track the mod first.' });
    registerRecordPanelContextCommands(deps);

    await editField()(IDENTITY, envelope);

    expect(report).toHaveBeenCalledWith('warning', 'Track the mod first.');
    expect(refreshSourceControlFor).not.toHaveBeenCalled();
  });

  it('reports a transport failure as an error', async () => {
    const { deps, meditClient, report } = makeDeps();
    meditClient.setCommandFailure('editRecord', new Error('ECONNREFUSED'));
    registerRecordPanelContextCommands(deps);

    await editField()(IDENTITY, envelope);

    expect(report).toHaveBeenCalledWith('error', expect.any(String), 'ECONNREFUSED');
  });

  describe('tells every panel', () => {
    const written = { type: EXTENSION_TO_WEBVIEW.EDIT_WRITTEN, ...IDENTITY, envelope };
    const refused = { type: EXTENSION_TO_WEBVIEW.EDIT_REFUSED, ...IDENTITY, envelope };

    it('the edit as it is sent, and nothing more once mEdit applies it', async () => {
      const { deps, meditClient, tellPanels } = makeDeps();
      tellPanels.mockImplementation(() => { expect(editRecordCalls(meditClient)).toHaveLength(0); });
      registerRecordPanelContextCommands(deps);

      await editField()(IDENTITY, envelope);

      expect(tellPanels.mock.calls).toEqual([[written]]);
    });

    it('a refused edit', async () => {
      const { deps, meditClient, tellPanels } = makeDeps();
      meditClient.setCommandResult('editRecord', { applied: false, refusal: 'NotTracked', message: 'Track the mod first.' });
      registerRecordPanelContextCommands(deps);

      await editField()(IDENTITY, envelope);

      expect(tellPanels.mock.calls).toEqual([[written], [refused]]);
    });

    it('nothing more of an edit mEdit never answered, since only the disk can say what it did', async () => {
      const { deps, meditClient, tellPanels } = makeDeps();
      meditClient.setCommandFailure('editRecord', new Error('ECONNREFUSED'));
      registerRecordPanelContextCommands(deps);

      await editField()(IDENTITY, envelope);

      expect(tellPanels.mock.calls).toEqual([[written]]);
    });

    it('nothing more of an element removed with no answer', async () => {
      const { deps, meditClient, tellPanels } = makeDeps();
      meditClient.setCommandFailure('editRecord', new Error('ECONNREFUSED'));
      registerRecordPanelContextCommands(deps);
      const path: ArrayElementContext['path'] = [{ kind: 'member', name: 'Values' }, { kind: 'index', index: 1 }];

      await present(handlers.get('modbench.record.removeElement'), 'the remove element handler')(elementContext(path));

      expect(tellPanels.mock.calls).toEqual([[{ ...written, envelope: { op: 'remove', path } }]]);
    });

    it('the FormKey the gate writes to, where the tab followed the record', async () => {
      const { deps, tellPanels } = makeDeps({ editGateOf: () => async (_address, write) => { await write('000900:MyMod.esp'); } });
      registerRecordPanelContextCommands(deps);

      await editField()(IDENTITY, envelope);

      expect(tellPanels.mock.calls).toEqual([[{ ...written, formKey: '000900:MyMod.esp' }]]);
    });
  });

  it('from the palette, asks for the focused string cell\'s new text and sets it at the cell\'s path', async () => {
    showInputBox.mockResolvedValue('a new description');
    const { deps, meditClient } = makeDeps({ focusedCell: () => stringContext() });
    registerRecordPanelContextCommands(deps);

    await editField()();

    expect(showInputBox).toHaveBeenCalledWith(expect.objectContaining({ value: 'a long description' }));
    expect(editRecordCalls(meditClient).map(c => c.args)).toEqual([[
      IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin,
      { op: 'set', path: [{ kind: 'member', name: 'Description' }], value: 'a new description' },
    ]]);
  });

  it('from the palette, writes nothing when the prompt is dismissed', async () => {
    showInputBox.mockResolvedValue(undefined);
    const { deps, meditClient } = makeDeps({ focusedCell: () => stringContext() });
    registerRecordPanelContextCommands(deps);

    await editField()();

    expect(editRecordCalls(meditClient)).toEqual([]);
  });

  it('from the palette, on a cell that is not a string value, writes nothing', async () => {
    const { deps, meditClient } = makeDeps({ focusedCell: () => parentContext(path) });
    registerRecordPanelContextCommands(deps);

    await editField()();

    expect(showInputBox).not.toHaveBeenCalled();
    expect(editRecordCalls(meditClient)).toEqual([]);
  });

  it('writes nothing for an Argument that is not a record\'s plugin copy', async () => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await editField()({ formKey: IDENTITY.formKey }, envelope);

    expect(editRecordCalls(meditClient)).toEqual([]);
  });
});

describe('modbench.record.openReference', () => {
  function reference() {
    registerRecordPanelContextCommands(makeDeps().deps);
    return present(handlers.get('modbench.record.openReference'), "the handler registered for 'modbench.record.openReference'");
  }

  it('opens the record the clicked reference points to, not the record the panel shows', async () => {
    await reference()({ webviewSection: 'cell reference', ...IDENTITY, referenceTarget: '000F:Fallout4.esm' });
    expect(executeCommand).toHaveBeenCalledWith('modbench.record.open', { formKey: '000F:Fallout4.esm' });
  });

  it('opens nothing from a cell that holds no reference', async () => {
    await reference()({ webviewSection: 'cell', ...IDENTITY });
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
