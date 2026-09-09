import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Real fs against a throwaway tmpdir, not a mocked fs: the chmod bits and content must land.
const openTextDocument = vi.fn();
const showTextDocument = vi.fn();
const onDidSaveTextDocument = vi.fn();
const onDidCloseTextDocument = vi.fn();

vi.mock('vscode', () => ({
  workspace: {
    openTextDocument: (...args: unknown[]) => openTextDocument(...args),
    onDidSaveTextDocument: (...args: unknown[]) => onDidSaveTextDocument(...args),
    onDidCloseTextDocument: (...args: unknown[]) => onDidCloseTextDocument(...args),
  },
  window: { showTextDocument: (...args: unknown[]) => showTextDocument(...args) },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
  ViewColumn: { One: 1, Beside: -2 },
}));

import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openExtendedFieldEditor, extendedEditorPath, type ExtendedFieldEditorDeps } from '../extendedFieldEditor';

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
    // Awaits each listener's promise so a test observes the handler finished, not merely started.
    fire: async (doc: { uri: { fsPath: string }; getText: () => string }) => { await Promise.all(listeners.map(l => l(doc))); },
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
    tempRoot,
    onCommit: vi.fn(),
    log: vi.fn(),
    reporter: { report: vi.fn() },
    ...overrides,
  };
}

describe('extendedEditorPath', () => {
  it('sanitizes reserved/colon characters and composes dir/origin/file from record, field, plugin', () => {
    const path = extendedEditorPath('/tmp/root', 'Deacon [000123:Fallout4.esm]', 'Description', 'Fallout4.esm', 'Data');
    // Brackets are valid on every filesystem; only the FormKey's colon is Windows-reserved.
    expect(path).toBe(join('/tmp/root', 'Deacon [000123_Fallout4.esm]', 'Data', 'Description [Fallout4.esm].txt'));
  });

  it('is deterministic — the same identity always produces the same path', () => {
    const a = extendedEditorPath('/tmp/root', 'Deacon [000123:Fallout4.esm]', 'Description', 'Fallout4.esm', 'Data');
    const b = extendedEditorPath('/tmp/root', 'Deacon [000123:Fallout4.esm]', 'Description', 'Fallout4.esm', 'Data');
    expect(a).toBe(b);
  });

  it('folds a non-Data origin into its own directory segment, between the record and the field', () => {
    const path = extendedEditorPath('/tmp/root', 'Deacon', 'Description', 'Shared.esp', 'ModA');
    expect(path).toBe(join('/tmp/root', 'Deacon', 'ModA', 'Description [Shared.esp].txt'));
  });

  it('two columns sharing a filename but differing in origin never collide', () => {
    const colA = extendedEditorPath('/tmp/root', 'Deacon', 'Description', 'Shared.esp', 'ModA');
    const colB = extendedEditorPath('/tmp/root', 'Deacon', 'Description', 'Shared.esp', 'ModB');
    expect(colA).not.toBe(colB);
  });

  // Origin is read off disk, so it is user-controlled input, not a trusted literal.
  it('strips path separators from a hostile origin, so it cannot escape tempRoot', () => {
    const path = extendedEditorPath('/tmp/root', 'Deacon', 'Description', 'Fallout4.esm', '../../../etc/passwd');
    expect(path.startsWith('/tmp/root')).toBe(true);
    expect(path).not.toContain('/etc/passwd');
    expect(path).toBe(join('/tmp/root', 'Deacon', '.._.._.._etc_passwd', 'Description [Fallout4.esm].txt'));
  });
});

describe('openExtendedFieldEditor', () => {
  beforeEach(() => {
    onDidSaveTextDocument.mockImplementation(makeFakeDocEvent().register);
    onDidCloseTextDocument.mockImplementation(makeFakeDocEvent().register);
    openTextDocument.mockResolvedValue({ uri: { fsPath: '' } });
    showTextDocument.mockResolvedValue(undefined);
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
    expect(mode & 0o200).not.toBe(0); // owner-write bit set
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
    expect(mode & 0o200).toBe(0); // owner-write bit cleared
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
    await saveEvent.fire({ uri: { fsPath: path }, getText: () => 'first save' });
    await saveEvent.fire({ uri: { fsPath: path }, getText: () => 'second save' });

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
    await saveEvent.fire({ uri: { fsPath: '/some/other/file.txt' }, getText: () => 'unrelated' });

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
    await closeEvent.fire({ uri: { fsPath: path }, getText: () => 'x' });

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

  // The second open rewrites a file the first already chmod'ed 0o444, which throws EACCES.
  it('a second open of the same immutable cell succeeds identically to the first (no EACCES)', async () => {
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
    expect(mode & 0o200).toBe(0); // still read-only after the second open
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

  // Proves the real write, not just the computed string, stays under tempRoot.
  it('a hostile origin cannot make the write land outside tempRoot', async () => {
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

  // VS Code's EOL-normalization and insertFinalNewline could silently alter embedded newlines.
  it('a multi-line value survives the full write -> save -> commit path unchanged', async () => {
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
    await saveEvent.fire({ uri: { fsPath: path }, getText: () => edited });

    expect(deps.onCommit).toHaveBeenCalledWith(edited);
  });
});
