import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so a row's handler can be invoked directly — the
// same idiom recordPanelContextCommands.test.ts and pluginRowCommands.test.ts already establish.
const {
  handlers, registerCommand, showWarningMessage, showErrorMessage, showInformationMessage, showInputBox, showQuickPick, workspaceFolders,
  TreeItem, ThemeIcon, EventEmitter, Range, Diagnostic, Uri,
} = vi.hoisted(() => {
  const handlers = new Map<string, (ctx?: unknown) => Promise<void> | void>();
  // `PluginTreeProvider.ts`/`ReferencedByTreeProvider.ts` are value imports (their node classes'
  // own `vscode.TreeItem` base) — these stubs exist only so that module chain loads.
  class TreeItem { label?: unknown; collapsibleState?: unknown; constructor(label?: unknown, collapsibleState?: unknown) { this.label = label; this.collapsibleState = collapsibleState; } }
  class ThemeIcon { id: string; constructor(id: string) { this.id = id; } }
  class EventEmitter { event = () => {}; fire = () => {}; }
  class Range { constructor(public a?: unknown, public b?: unknown, public c?: unknown, public d?: unknown) {} }
  class Diagnostic { constructor(public range?: unknown, public message?: unknown, public severity?: unknown) {} }
  class Uri { static file(p: string) { return { fsPath: p }; } }
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (ctx?: unknown) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    workspaceFolders: { value: undefined as { uri: { fsPath: string } }[] | undefined },
    TreeItem, ThemeIcon, EventEmitter, Range, Diagnostic, Uri,
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand, executeCommand: vi.fn() },
  window: {
    showWarningMessage, showErrorMessage, showInformationMessage, showInputBox, showQuickPick,
  },
  workspace: { get workspaceFolders() { return workspaceFolders.value; } },
  TreeItem, ThemeIcon, EventEmitter, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  Range, Diagnostic, DiagnosticSeverity: { Warning: 1, Error: 0 }, Uri,
}));

import { registerRecordLifecycleCommands, runCopyRecordCommand, compileAndReport } from '../editorCommands';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

function fakeOutputChannel() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
}

// ── registerRecordLifecycleCommands: create / delete / renumber ──────────────

describe('registerRecordLifecycleCommands', () => {
  function invoke(controller: any, repository: any = {}) {
    const treeProvider = { refresh: vi.fn() } as any;
    const refreshMatchingPlugins = vi.fn();
    registerRecordLifecycleCommands(controller, repository, fakeOutputChannel(), treeProvider, refreshMatchingPlugins);
    return { treeProvider, refreshMatchingPlugins };
  }

  it('shows the ready-to-show message and refreshes nothing when the backend refuses a create', async () => {
    const controller = { createRecord: vi.fn().mockResolvedValue({ refused: true, message: 'mEdit: Could not create a new npc_ record in "MyPatch.esp" — boom' }) };
    const { treeProvider, refreshMatchingPlugins } = invoke(controller);

    await handlers.get('modbench.record.create')!({ kind: 'recordType', plugin: 'MyPatch.esp', origin: 'ModA', recordType: 'npc_' });

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not create a new npc_ record in "MyPatch.esp" — boom');
    expect(treeProvider.refresh).not.toHaveBeenCalled();
    expect(refreshMatchingPlugins).not.toHaveBeenCalled();
  });

  it('shows the ready-to-show message and refreshes nothing when the backend refuses a delete', async () => {
    const controller = { deleteRecord: vi.fn().mockResolvedValue({ refused: true, message: 'mEdit: Could not delete 000801:MyPatch.esp — boom' }) };
    const { treeProvider } = invoke(controller);
    showWarningMessage.mockResolvedValue('Remove');

    await handlers.get('modbench.record.delete')!({
      kind: 'record', origin: 'ModA', record: { formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', editorId: null },
    });

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not delete 000801:MyPatch.esp — boom');
    expect(treeProvider.refresh).not.toHaveBeenCalled();
  });

  it('shows the ready-to-show message and refreshes nothing when the backend refuses a renumber', async () => {
    const controller = { renumberRecord: vi.fn().mockResolvedValue({ refused: true, message: 'mEdit: Could not renumber 000801:MyPatch.esp — boom' }) };
    const repository = { peekNextFreeFormKey: vi.fn().mockResolvedValue('000900:MyPatch.esp'), getReferences: vi.fn().mockResolvedValue([]) };
    const { treeProvider } = invoke(controller, repository);
    showInputBox.mockResolvedValue('000900:MyPatch.esp');
    showWarningMessage.mockResolvedValue(undefined); // renumberConfirmMessage returns null with zero references — no modal to answer

    await handlers.get('modbench.record.renumber')!({
      kind: 'record', origin: 'ModA', record: { formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', editorId: null },
    });

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not renumber 000801:MyPatch.esp — boom');
    expect(treeProvider.refresh).not.toHaveBeenCalled();
  });
});

// ── runCopyRecordCommand: copy-as-override / copy-as-new ──────────────────────

describe('runCopyRecordCommand', () => {
  function repo(plugins: unknown[] = []) {
    return { getPlugins: vi.fn().mockResolvedValue(plugins), getRecordOverridePlugins: vi.fn().mockResolvedValue([]) } as any;
  }
  const arg = { kind: 'record', origin: 'ModA', record: { formKey: '000801:Fallout4.esm', plugin: 'Fallout4.esm' } } as any;
  const resolveOriginOrReport = (node: { origin?: string }) => Promise.resolve(node.origin);

  it('shows the ready-to-show message and refreshes nothing when the backend refuses a copy-as-override', async () => {
    const controller = { copyRecordAsOverride: vi.fn().mockResolvedValue({ refused: true, message: 'mEdit: Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom' }) };
    const onWritten = vi.fn();
    showQuickPick.mockResolvedValue({ label: 'MyPatch.esp', plugin: { name: 'MyPatch.esp', origin: 'ModA' } });

    await runCopyRecordCommand('copy-as-override', arg, controller as any, repo([{ name: 'MyPatch.esp', origin: 'ModA' }]), resolveOriginOrReport, fakeOutputChannel(), onWritten);

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom');
    expect(onWritten).not.toHaveBeenCalled();
  });

  it('shows the ready-to-show message and refreshes nothing when the backend refuses a copy-as-new-record', async () => {
    const controller = { copyRecordAsNewRecord: vi.fn().mockResolvedValue({ refused: true, message: 'mEdit: Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom' }) };
    const onWritten = vi.fn();
    showQuickPick.mockResolvedValue({ label: 'MyPatch.esp', plugin: { name: 'MyPatch.esp', origin: 'ModA' } });

    await runCopyRecordCommand('copy-as-new', arg, controller as any, repo([{ name: 'MyPatch.esp', origin: 'ModA' }]), resolveOriginOrReport, fakeOutputChannel(), onWritten);

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom');
    expect(onWritten).not.toHaveBeenCalled();
  });
});

// ── compileAndReport ───────────────────────────────────────────────────────

describe('compileAndReport', () => {
  it('shows the ready-to-show message on a transport-level refusal (WriteRefused), never the typed-refusal wording', async () => {
    const controller = { compile: vi.fn().mockResolvedValue({ refused: true, message: 'mEdit: Could not compile "MyPatch.esp" — boom' }) };
    const diagnostics = { delete: vi.fn(), set: vi.fn(), [Symbol.iterator]: function* () {} } as any;

    await compileAndReport(controller as any, diagnostics, { name: 'MyPatch.esp', origin: 'ModA' }, undefined, {} as any);

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not compile "MyPatch.esp" — boom');
    expect(showInformationMessage).not.toHaveBeenCalled();
  });
});
