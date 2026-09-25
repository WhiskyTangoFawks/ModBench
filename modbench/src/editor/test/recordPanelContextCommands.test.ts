import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so each row's handler can be invoked directly.
const handlers = new Map<string, (ctx?: unknown) => Promise<void> | void>();
const registerCommand = vi.fn((command: string, handler: (ctx?: unknown) => Promise<void> | void) => {
  handlers.set(command, handler);
  return { dispose: vi.fn() };
});
vi.mock('vscode', () => ({
  commands: { registerCommand: (...args: [string, (ctx?: unknown) => void]) => registerCommand(...args) },
}));

import type { ExtendedFieldEditorDeps, OpenExtendedFieldEditorParams } from '../extendedFieldEditor';

// Stubbed so the command's own wiring is what this file observes: which tab the gesture asks for,
// and what its save writes. The tab's fs/chmod mechanics are extendedFieldEditor.test.ts's.
const openExtendedFieldEditor =
  vi.fn<(params: OpenExtendedFieldEditorParams, deps: ExtendedFieldEditorDeps) => Promise<void>>();
vi.mock('../extendedFieldEditor', () => ({
  openExtendedFieldEditor: (...args: [OpenExtendedFieldEditorParams, ExtendedFieldEditorDeps]) =>
    openExtendedFieldEditor(...args),
}));

import { registerRecordPanelContextCommands, type RecordPanelContextCommandDeps } from '../recordPanelContextCommands';
import type { ArrayElementContext, ArrayParentContext, StringValueContext } from '../../wire/messages';
import { InMemoryMEditClient } from '../../client';
import { present } from '../../ports/present';

beforeEach(() => { handlers.clear(); registerCommand.mockClear(); openExtendedFieldEditor.mockClear(); });

function makeDeps(overrides: Partial<RecordPanelContextCommandDeps> = {}) {
  const meditClient = new InMemoryMEditClient();
  meditClient.setCommandResult('editRecord', { applied: true });
  const onRecordEdited = vi.fn();
  const report = vi.fn();
  const deps: RecordPanelContextCommandDeps = {
    meditClient,
    onRecordEdited,
    reporter: { report, landed: vi.fn(), insideDialog: vi.fn(), selectionOutcome: vi.fn() },
    fieldFile: () => ({ folder: '/tmp/does-not-open-here', file: '/tmp/does-not-open-here/field.txt' }),
    log: vi.fn(),
    // The right-clicked panel's gate, sending each write where it was addressed.
    editGateOf: () => async (address, write) => { await write(address.formKey); },
    focusedCell: () => undefined,
    ...overrides,
  };
  return { deps, meditClient, onRecordEdited, report };
}

const IDENTITY = { formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA' };

function editRecordCalls(client: InMemoryMEditClient) {
  return client.calls.filter(c => c.method === 'editRecord');
}

// A recorded call carries only `unknown[]` — the envelope's own `value` is `unknown` on the wire
// too (messages.ts), so a test reading one back narrows through this either way.
function envelopeValue(args: unknown[]): string {
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

// ADR-0007: the right-click gesture writes from the host, so the observable is the port call
// — one envelope per gesture, never a message back into the panel.
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

  it('Remove lands a remove envelope at a keyed element\'s own path', async () => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.removeElement'), "the handler registered for 'modbench.record.removeElement'")(elementContext(
      [{ kind: 'member', name: 'Scripts' }, { kind: 'key', key: 'Guard' }],
    ));

    expect(present(editRecordCalls(meditClient)[0], "the sole editRecord call").args).toEqual([
      IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin,
      { op: 'remove', path: [{ kind: 'member', name: 'Scripts' }, { kind: 'key', key: 'Guard' }] },
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

  // The webview posts what the user asked for; a move off either end is refused by name at the
  // backend (ADR-0005), never silently dropped here.
  it('Move Up on the first element still lands the move, to the position before it', async () => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.moveElementUp'), "the handler registered for 'modbench.record.moveElementUp'")(elementContext([{ kind: 'member', name: 'Values' }, { kind: 'index', index: 0 }]));

    expect(present(editRecordCalls(meditClient)[0], "the sole editRecord call").args).toEqual([
      IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin,
      { op: 'move', path: [{ kind: 'member', name: 'Values' }, { kind: 'index', index: 0 }], value: -1 },
    ]);
  });

  it('tells the panel to re-read once the edit has landed', async () => {
    const { deps, onRecordEdited } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.addElement'), "the handler registered for 'modbench.record.addElement'")(parentContext([{ kind: 'member', name: 'Values' }]));

    expect(onRecordEdited).toHaveBeenCalledWith(IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin);
  });

  it('surfaces a refusal as a warning and does not re-read', async () => {
    const { deps, meditClient, onRecordEdited, report } = makeDeps();
    meditClient.setCommandResult('editRecord', { applied: false, refusal: 'NotTracked', message: 'Track the mod first.' });
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.addElement'), "the handler registered for 'modbench.record.addElement'")(parentContext([{ kind: 'member', name: 'Values' }]));

    expect(report).toHaveBeenCalledWith('warning', 'Track the mod first.');
    expect(onRecordEdited).not.toHaveBeenCalled();
  });

  it('does nothing when a command fires with no context', async () => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.addElement'), "the handler registered for 'modbench.record.addElement'")(undefined);

    expect(editRecordCalls(meditClient)).toHaveLength(0);
  });
});

// A right-click edit is an edit the panel makes, so it goes through that panel's gate: the gate
// holds its reads, and sends the write to the FormKey the record is at now.
describe('right-click edits go through the right-clicked panel\'s gate', () => {
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

  // The menu names its panel (the body's webview context), whichever panel was focused last.
  it('takes the gate of the panel the menu came from', async () => {
    const asked: (string | undefined)[] = [];
    const { deps } = makeDeps({ editGateOf: panelId => { asked.push(panelId); return async (address, write) => { await write(address.formKey); }; } });
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.addElement'), 'the addElement handler')(
      { ...parentContext([{ kind: 'member', name: 'Entries' }]), panelId: 'panel-2' });

    expect(asked).toEqual(['panel-2']);
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

// ADR-0018: right-click is the extended editor's only trigger, and the host opens the tab from the
// context it is handed rather than asking the panel for anything.
describe('the extended editor opens and saves from the host', () => {
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
    const { deps, meditClient, onRecordEdited } = makeDeps();
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
    expect(onRecordEdited).toHaveBeenCalledWith(IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin);
  });

  it('a second save of the same tab writes again', async () => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.openFieldValue'), "the handler registered for 'modbench.record.openFieldValue'")(stringContext());
    await openedWith().deps.onCommit('first save');
    await openedWith().deps.onCommit('second save');

    expect(editRecordCalls(meditClient).map(c => envelopeValue(c.args))).toEqual(['first save', 'second save']);
  });
});

// commands.md, Record: a field gesture from the palette acts on the focused cell of the record tab
// in focus, which the palette never hands it.
describe('a field gesture from the palette', () => {
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

  // A string element of an array carries both sections, as its right-click does.
  it('acts on a cell whose context carries its section beside another', async () => {
    const path: ArrayElementContext['path'] = [{ kind: 'member', name: 'Names' }, { kind: 'index', index: 0 }];
    const { deps, meditClient } = makeDeps({
      focusedCell: () => ({ ...elementContext(path), webviewSection: 'arrayElement stringValue' }),
    });
    registerRecordPanelContextCommands(deps);

    await present(handlers.get('modbench.record.removeElement'), 'the remove element handler')();

    expect(editRecordCalls(meditClient).map(c => c.args[3])).toEqual([{ op: 'remove', path }]);
  });
});
