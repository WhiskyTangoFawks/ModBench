import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type FakeTextDocument = { uri: { fsPath: string }; getText?: () => string };
type DocEventListener = (doc: { uri: { fsPath: string }; getText: () => string }) => unknown;
type DocEventRegister = (listener: DocEventListener) => { dispose: () => void };

const OWNER_WRITE_BIT = 0o200;

const openTextDocument = vi.fn<(uri: { fsPath: string }) => Promise<FakeTextDocument>>();
const showTextDocument = vi.fn<(doc: unknown, opts?: unknown) => Promise<unknown>>();
const onDidSaveTextDocument = vi.fn<DocEventRegister>();
const onDidCloseTextDocument = vi.fn<DocEventRegister>();
const executeCommand = vi.fn<(command: string) => Promise<unknown>>();

vi.mock('vscode', () => ({
  workspace: {
    openTextDocument: (uri: { fsPath: string }) => openTextDocument(uri),
    onDidSaveTextDocument: (listener: DocEventListener) => onDidSaveTextDocument(listener),
    onDidCloseTextDocument: (listener: DocEventListener) => onDidCloseTextDocument(listener),
  },
  commands: { executeCommand: (command: string) => executeCommand(command) },
  window: { showTextDocument: (doc: unknown, opts?: unknown) => showTextDocument(doc, opts) },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
  ViewColumn: { One: 1, Beside: -2 },
}));

import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openExtendedFieldEditor, type ExtendedFieldEditorDeps } from '../extendedFieldEditor';

type FieldFile = ExtendedFieldEditorDeps['fieldFile'];

const fieldFileUnderWithEverySegmentEscaped = (tempRoot: string): FieldFile => (field) => {
  const folder = join(tempRoot, encodeURIComponent(field.recordLabel), encodeURIComponent(field.origin));
  return { folder, file: join(folder, `${encodeURIComponent(field.fieldName)} [${encodeURIComponent(field.plugin)}]`) };
};

const extendedEditorPath = (tempRoot: string, recordLabel: string, fieldName: string, plugin: string, origin: string) =>
  fieldFileUnderWithEverySegmentEscaped(tempRoot)({ recordLabel, fieldName, plugin, origin }).file;

function makeFakeDocEvent() {
  const listeners: Array<(doc: { uri: { fsPath: string }; getText: () => string }) => unknown> = [];
  const disposed: boolean[] = [];
  const register = vi.fn((listener: (doc: { uri: { fsPath: string }; getText: () => string }) => unknown) => {
    listeners.push(listener);
    const index = listeners.length - 1;
    disposed.push(false);
    return { dispose: () => { disposed[index] = true; } };
  });
  return {
    register,
    fireAndAwaitEveryListener: async (doc: { uri: { fsPath: string }; getText: () => string }) => { await Promise.all(listeners.map(l => l(doc))); },
    isDisposed: (index = 0) => disposed[index],
  };
}

let tempRoots: string[] = [];
async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'medit-extended-editor-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.map(root => rm(root, { recursive: true, force: true })));
  tempRoots = [];
  vi.clearAllMocks();
});

function makeDeps(tempRoot: string, overrides: Partial<ExtendedFieldEditorDeps> = {}): ExtendedFieldEditorDeps {
  return {
    fieldFile: fieldFileUnderWithEverySegmentEscaped(tempRoot),
    onCommit: vi.fn(),
    log: vi.fn(),
    reporter: { report: vi.fn(), landed: vi.fn(), insideDialog: vi.fn(), selectionOutcome: vi.fn() },
    ...overrides,
  };
}

describe('openExtendedFieldEditor', () => {
  beforeEach(() => {
    onDidSaveTextDocument.mockImplementation(makeFakeDocEvent().register);
    onDidCloseTextDocument.mockImplementation(makeFakeDocEvent().register);
    openTextDocument.mockResolvedValue({ uri: { fsPath: '' } });
    showTextDocument.mockResolvedValue(undefined);
    executeCommand.mockResolvedValue(undefined);
  });

  it('writes the value to the deterministic temp path and opens it beside, as a non-preview tab', async () => {
    const tempRoot = await makeTempRoot();
    const path = extendedEditorPath(tempRoot, 'Deacon [000123:Fallout4.esm]', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path }, getText: () => 'a long description' });

    await openExtendedFieldEditor(
      { value: 'a long description', recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: false },
      makeDeps(tempRoot),
    );

    expect(await readFile(path, 'utf8')).toBe('a long description');
    expect(showTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ uri: { fsPath: path } }),
      expect.objectContaining({ viewColumn: -2, preview: false }),
    );
  });

  it('leaves a mutable temp file writable', async () => {
    const tempRoot = await makeTempRoot();
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path }, getText: () => 'x' });

    await openExtendedFieldEditor(
      { value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: false },
      makeDeps(tempRoot),
    );

    const mode = (await stat(path)).mode & 0o777;
    expect(mode & OWNER_WRITE_BIT).not.toBe(0);
  });

  it('marks an immutable (readOnly) temp file non-writable', async () => {
    const tempRoot = await makeTempRoot();
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path }, getText: () => 'x' });

    await openExtendedFieldEditor(
      { value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: true },
      makeDeps(tempRoot),
    );

    const mode = (await stat(path)).mode & 0o777;
    expect(mode & OWNER_WRITE_BIT).toBe(0);
  });

  it('commits the saved content on every save, not just the first', async () => {
    const tempRoot = await makeTempRoot();
    const saveEvent = makeFakeDocEvent();
    onDidSaveTextDocument.mockImplementation(saveEvent.register);
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    const deps = makeDeps(tempRoot);

    await openExtendedFieldEditor(
      { value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: false },
      deps,
    );
    await saveEvent.fireAndAwaitEveryListener({ uri: { fsPath: path }, getText: () => 'first save' });
    await saveEvent.fireAndAwaitEveryListener({ uri: { fsPath: path }, getText: () => 'second save' });

    expect(deps.onCommit).toHaveBeenNthCalledWith(1, 'first save');
    expect(deps.onCommit).toHaveBeenNthCalledWith(2, 'second save');
  });

  it('ignores a save event for a different document', async () => {
    const tempRoot = await makeTempRoot();
    const saveEvent = makeFakeDocEvent();
    onDidSaveTextDocument.mockImplementation(saveEvent.register);
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    const deps = makeDeps(tempRoot);

    await openExtendedFieldEditor(
      { value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: false },
      deps,
    );
    await saveEvent.fireAndAwaitEveryListener({ uri: { fsPath: '/some/other/file.txt' }, getText: () => 'unrelated' });

    expect(deps.onCommit).not.toHaveBeenCalled();
  });

  it('on close: deletes the temp file and disposes both listeners', async () => {
    const tempRoot = await makeTempRoot();
    const saveEvent = makeFakeDocEvent();
    const closeEvent = makeFakeDocEvent();
    onDidSaveTextDocument.mockImplementation(saveEvent.register);
    onDidCloseTextDocument.mockImplementation(closeEvent.register);
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    const deps = makeDeps(tempRoot);

    await openExtendedFieldEditor(
      { value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: false },
      deps,
    );
    await closeEvent.fireAndAwaitEveryListener({ uri: { fsPath: path }, getText: () => 'x' });

    expect(saveEvent.isDisposed()).toBe(true);
    expect(closeEvent.isDisposed()).toBe(true);
    await expect(stat(path)).rejects.toThrow();
  });

  it('reports an error and does not throw when opening fails', async () => {
    const deps = makeDeps('/nonexistent-root-\0-invalid');

    await expect(openExtendedFieldEditor(
      { value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: false },
      deps,
    )).resolves.toBeUndefined();

    expect(deps.reporter.report).toHaveBeenCalledWith('error', 'Could not open the extended editor.', expect.any(String));
  });

  it('a second open of the same immutable cell succeeds identically to the first, though the first chmod\'ed the file 0o444 and a rewrite would throw EACCES', async () => {
    const tempRoot = await makeTempRoot();
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path }, getText: () => 'x' });
    const params = { value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: true };

    const firstDeps = makeDeps(tempRoot);
    await openExtendedFieldEditor(params, firstDeps);
    expect(firstDeps.reporter.report).not.toHaveBeenCalled();

    const secondDeps = makeDeps(tempRoot);
    await openExtendedFieldEditor(params, secondDeps);

    expect(secondDeps.reporter.report).not.toHaveBeenCalled();
    const mode = (await stat(path)).mode & 0o777;
    expect(mode & OWNER_WRITE_BIT).toBe(0);
  });

  it('two columns sharing a filename but differing in origin open independent temp files', async () => {
    const tempRoot = await makeTempRoot();
    const colAPath = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Shared.esp', 'ModA');
    const colBPath = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Shared.esp', 'ModB');
    openTextDocument.mockImplementation((uri: { fsPath: string }) => Promise.resolve({ uri, getText: () => '' }));

    await openExtendedFieldEditor(
      { value: 'from ModA', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Shared.esp', origin: 'ModA', readOnly: false },
      makeDeps(tempRoot),
    );
    await openExtendedFieldEditor(
      { value: 'from ModB', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Shared.esp', origin: 'ModB', readOnly: false },
      makeDeps(tempRoot),
    );

    expect(colAPath).not.toBe(colBPath);
    expect(await readFile(colAPath, 'utf8')).toBe('from ModA');
    expect(await readFile(colBPath, 'utf8')).toBe('from ModB');
  });

  it('a hostile origin cannot make the write land outside the file the port answers', async () => {
    const tempRoot = await makeTempRoot();
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', '../../../etc/passwd');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path }, getText: () => 'x' });

    await openExtendedFieldEditor(
      { value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: '../../../etc/passwd', readOnly: false },
      makeDeps(tempRoot),
    );

    expect(path.startsWith(tempRoot)).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('x');
  });

  it('a multi-line value, whose newlines VS Code\'s EOL normalization and insertFinalNewline could alter, survives the full write -> save -> commit path unchanged', async () => {
    const tempRoot = await makeTempRoot();
    const saveEvent = makeFakeDocEvent();
    onDidSaveTextDocument.mockImplementation(saveEvent.register);
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    const multiline = 'First line.\nSecond line.\n\nFourth line, after a blank one.';
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    const deps = makeDeps(tempRoot);

    await openExtendedFieldEditor(
      { value: multiline, recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: false },
      deps,
    );
    expect(await readFile(path, 'utf8')).toBe(multiline);

    const edited = `${multiline}\nA fifth line, added in the editor.`;
    await saveEvent.fireAndAwaitEveryListener({ uri: { fsPath: path }, getText: () => edited });

    expect(deps.onCommit).toHaveBeenCalledWith(edited);
  });

  const deacon = { value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data' };

  it('a second open of a tab still open shows it without rewriting the file or adding a listener', async () => {
    const tempRoot = await makeTempRoot();
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    await openExtendedFieldEditor({ ...deacon, readOnly: false }, makeDeps(tempRoot));
    await writeFile(path, 'unsaved edit on disk');
    const saveRegistrations = onDidSaveTextDocument.mock.calls.length;

    await openExtendedFieldEditor({ ...deacon, value: 'newer', readOnly: false }, makeDeps(tempRoot));

    expect(await readFile(path, 'utf8')).toBe('unsaved edit on disk');
    expect(onDidSaveTextDocument).toHaveBeenCalledTimes(saveRegistrations);
    expect(showTextDocument).toHaveBeenCalledTimes(2);
  });

  it('opened again after its tab closed, writes the value afresh', async () => {
    const tempRoot = await makeTempRoot();
    const closeEvent = makeFakeDocEvent();
    onDidCloseTextDocument.mockImplementation(closeEvent.register);
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    await openExtendedFieldEditor({ ...deacon, readOnly: false }, makeDeps(tempRoot));
    await closeEvent.fireAndAwaitEveryListener({ uri: { fsPath: path }, getText: () => 'x' });

    await openExtendedFieldEditor({ ...deacon, value: 'again', readOnly: false }, makeDeps(tempRoot));

    expect(await readFile(path, 'utf8')).toBe('again');
  });

  it('holds a read-only tab read-only whatever files.readonlyFromPermissions says', async () => {
    const tempRoot = await makeTempRoot();
    await openExtendedFieldEditor({ ...deacon, readOnly: true }, makeDeps(tempRoot));

    expect(executeCommand).toHaveBeenCalledWith('workbench.action.files.setActiveEditorReadonlyInSession');
  });

  it('leaves an editable tab alone', async () => {
    const tempRoot = await makeTempRoot();
    await openExtendedFieldEditor({ ...deacon, readOnly: false }, makeDeps(tempRoot));

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('two concurrent opens of one cell write once and register one listener pair', async () => {
    const tempRoot = await makeTempRoot();
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });

    await Promise.all([
      openExtendedFieldEditor({ ...deacon, readOnly: false }, makeDeps(tempRoot)),
      openExtendedFieldEditor({ ...deacon, value: 'second', readOnly: false }, makeDeps(tempRoot)),
    ]);

    expect(await readFile(path, 'utf8')).toBe('x');
    expect(onDidSaveTextDocument).toHaveBeenCalledTimes(1);
    expect(onDidCloseTextDocument).toHaveBeenCalledTimes(1);
  });

  it('a failing show on a tab already open keeps it known, so a later open still does not rewrite', async () => {
    const tempRoot = await makeTempRoot();
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    await openExtendedFieldEditor({ ...deacon, readOnly: false }, makeDeps(tempRoot));
    showTextDocument.mockRejectedValueOnce(new Error('no window'));
    const failing = makeDeps(tempRoot);
    await openExtendedFieldEditor({ ...deacon, readOnly: false }, failing);
    expect(failing.reporter.report).toHaveBeenCalledWith('error', 'Could not open the extended editor.', 'no window');
    await writeFile(path, 'unsaved edit on disk');

    await openExtendedFieldEditor({ ...deacon, readOnly: false }, makeDeps(tempRoot));

    expect(await readFile(path, 'utf8')).toBe('unsaved edit on disk');
    expect(onDidSaveTextDocument).toHaveBeenCalledTimes(1);
  });

  it('a failing read-only command is reported and the tab still saves', async () => {
    const tempRoot = await makeTempRoot();
    const saveEvent = makeFakeDocEvent();
    onDidSaveTextDocument.mockImplementation(saveEvent.register);
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    executeCommand.mockRejectedValueOnce(new Error('no such command'));
    const deps = makeDeps(tempRoot);

    await openExtendedFieldEditor({ ...deacon, readOnly: true }, deps);
    await saveEvent.fireAndAwaitEveryListener({ uri: { fsPath: path }, getText: () => 'saved' });

    expect(deps.reporter.report).toHaveBeenCalledWith('error', 'Could not open the extended editor.', 'no such command');
    expect(deps.onCommit).toHaveBeenCalledWith('saved');
  });
});
