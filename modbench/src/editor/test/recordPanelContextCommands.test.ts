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

// Stubbed so the command's own wiring is what this file observes: which tab the gesture asks for,
// and what its save writes. The tab's fs/chmod mechanics are extendedFieldEditor.test.ts's.
const openExtendedFieldEditor = vi.fn();
vi.mock('../extendedFieldEditor', () => ({
  openExtendedFieldEditor: (...args: unknown[]) => openExtendedFieldEditor(...args),
}));

import { registerRecordPanelContextCommands, type RecordPanelContextCommandDeps } from '../recordPanelContextCommands';
import type { ArrayElementContext, ArrayParentContext, StringValueContext } from '../../medit/messages';
import type { ExtendedFieldEditorDeps, OpenExtendedFieldEditorParams } from '../extendedFieldEditor';
import { InMemoryMEditClient } from '../../medit/client';

beforeEach(() => { handlers.clear(); registerCommand.mockClear(); openExtendedFieldEditor.mockClear(); });

function makeDeps(overrides: Partial<RecordPanelContextCommandDeps> = {}) {
  const meditClient = new InMemoryMEditClient();
  meditClient.setCommandResult('editRecord', { applied: true });
  const onRecordEdited = vi.fn();
  const report = vi.fn();
  const deps: RecordPanelContextCommandDeps = {
    meditClient,
    onRecordEdited,
    reporter: { report, landed: vi.fn() },
    tempRoot: '/tmp/does-not-open-here',
    log: vi.fn(),
    ...overrides,
  };
  return { deps, meditClient, onRecordEdited, report };
}

const IDENTITY = { formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA' };

function editRecordCalls(client: InMemoryMEditClient) {
  return client.calls.filter(c => c.method === 'editRecord');
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

    await handlers.get('modbench.array.add')!(parentContext(
      [{ kind: 'member', name: 'Container' }, { kind: 'member', name: 'Entries' }],
    ));

    expect(editRecordCalls(meditClient)).toHaveLength(1);
    expect(editRecordCalls(meditClient)[0]!.args).toEqual([
      IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin,
      { op: 'add', path: [{ kind: 'member', name: 'Container' }, { kind: 'member', name: 'Entries' }] },
    ]);
  });

  it('Remove lands a remove envelope at a keyed element\'s own path', async () => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await handlers.get('modbench.array.remove')!(elementContext(
      [{ kind: 'member', name: 'Scripts' }, { kind: 'key', key: 'Guard' }],
    ));

    expect(editRecordCalls(meditClient)[0]!.args).toEqual([
      IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin,
      { op: 'remove', path: [{ kind: 'member', name: 'Scripts' }, { kind: 'key', key: 'Guard' }] },
    ]);
  });

  it.each([
    ['modbench.array.moveUp', 1],
    ['modbench.array.moveDown', 3],
  ] as const)('%s lands a move envelope carrying the neighbour position', async (command, destination) => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await handlers.get(command)!(elementContext(
      [{ kind: 'member', name: 'Container' }, { kind: 'member', name: 'Entries' }, { kind: 'index', index: 2 }],
    ));

    expect(editRecordCalls(meditClient)[0]!.args).toEqual([
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

    await handlers.get('modbench.array.moveUp')!(elementContext([{ kind: 'member', name: 'Values' }, { kind: 'index', index: 0 }]));

    expect(editRecordCalls(meditClient)[0]!.args).toEqual([
      IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin,
      { op: 'move', path: [{ kind: 'member', name: 'Values' }, { kind: 'index', index: 0 }], value: -1 },
    ]);
  });

  it('tells the panel to re-read once the edit has landed', async () => {
    const { deps, onRecordEdited } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await handlers.get('modbench.array.add')!(parentContext([{ kind: 'member', name: 'Values' }]));

    expect(onRecordEdited).toHaveBeenCalledWith(IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin);
  });

  it('surfaces a refusal as a warning and does not re-read', async () => {
    const { deps, meditClient, onRecordEdited, report } = makeDeps();
    meditClient.setCommandResult('editRecord', { applied: false, refusal: 'NotTracked', message: 'Track the mod first.' });
    registerRecordPanelContextCommands(deps);

    await handlers.get('modbench.array.add')!(parentContext([{ kind: 'member', name: 'Values' }]));

    expect(report).toHaveBeenCalledWith('warning', 'Track the mod first.');
    expect(onRecordEdited).not.toHaveBeenCalled();
  });

  it('does nothing when a command fires with no context', async () => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await handlers.get('modbench.array.add')!(undefined);

    expect(editRecordCalls(meditClient)).toHaveLength(0);
  });
});

// ADR-0018: right-click is the extended editor's only trigger, and the host opens the tab from the
// context it is handed rather than asking the panel for anything.
describe('the extended editor opens and saves from the host', () => {
  function openedWith(): { params: OpenExtendedFieldEditorParams; deps: ExtendedFieldEditorDeps } {
    const [params, editorDeps] = openExtendedFieldEditor.mock.calls.at(-1) as
      [OpenExtendedFieldEditorParams, ExtendedFieldEditorDeps];
    return { params, deps: editorDeps };
  }

  it('opens the tab with the record label and the row\'s own label from the context', async () => {
    const { deps } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await handlers.get('modbench.field.openExtended')!(stringContext({
      recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Id', readOnly: true,
    }));

    expect(openedWith().params).toEqual({
      value: 'a long description', recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Id',
      plugin: IDENTITY.plugin, origin: IDENTITY.origin, readOnly: true,
    });
  });

  it('threads the load order-static temp root and log through to the editor', async () => {
    const { deps } = makeDeps({ tempRoot: '/tmp/modbench-fields' });
    registerRecordPanelContextCommands(deps);

    await handlers.get('modbench.field.openExtended')!(stringContext());

    expect(openedWith().deps.tempRoot).toBe('/tmp/modbench-fields');
  });

  it('a save lands one set envelope at the leaf\'s own path, and re-reads', async () => {
    const { deps, meditClient, onRecordEdited } = makeDeps();
    registerRecordPanelContextCommands(deps);
    const path = [
      { kind: 'member', name: 'Container' }, { kind: 'index', index: 0 }, { kind: 'member', name: 'Id' },
    ] as StringValueContext['path'];

    await handlers.get('modbench.field.openExtended')!(stringContext({ path }));
    await openedWith().deps.onCommit('edited in the tab');

    expect(editRecordCalls(meditClient)[0]!.args).toEqual([
      IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin,
      { op: 'set', path, value: 'edited in the tab' },
    ]);
    expect(onRecordEdited).toHaveBeenCalledWith(IDENTITY.formKey, IDENTITY.plugin, IDENTITY.origin);
  });

  it('a second save of the same tab writes again', async () => {
    const { deps, meditClient } = makeDeps();
    registerRecordPanelContextCommands(deps);

    await handlers.get('modbench.field.openExtended')!(stringContext());
    await openedWith().deps.onCommit('first save');
    await openedWith().deps.onCommit('second save');

    expect(editRecordCalls(meditClient).map(c => (c.args[3] as { value: string }).value)).toEqual(['first save', 'second save']);
  });
});
