import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Issue #230: same "mock vscode, use real fs against a throwaway tmpdir" shape
// DownloadsPanel.test.ts already established for a real-file-backed editor tab — more faithful
// than mocking fs too (proves the actual chmod bits and content land on disk), and the tmpdir is
// disposable so nothing leaks into the real OS temp dir beyond one test run.
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
import { openExtendedFieldEditor, extendedEditorPath, type ExtendedFieldEditorDeps } from './extendedFieldEditor';
import { EXTENSION_TO_WEBVIEW } from './messages';

// makeFakeDocEvent: a minimal fake of vscode's Disposable-returning event-registration functions
// (onDidSaveTextDocument/onDidCloseTextDocument) — the test fires the registered listener
// directly, matching real VS Code's "the callback receives the TextDocument" shape, and tracks
// disposal so the cleanup tests can assert both listeners are torn down together.
function makeFakeDocEvent() {
  const listeners: Array<(doc: { uri: { fsPath: string }; getText: () => string }) => void> = [];
  const disposed: boolean[] = [];
  const register = vi.fn((listener: (doc: { uri: { fsPath: string }; getText: () => string }) => void) => {
    listeners.push(listener);
    const index = listeners.length - 1;
    disposed.push(false);
    return { dispose: () => { disposed[index] = true; } };
  });
  return {
    register,
    fire: (doc: { uri: { fsPath: string }; getText: () => string }) => listeners.forEach(l => l(doc)),
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
    reply: vi.fn(),
    log: vi.fn(),
    reporter: { report: vi.fn() },
    ...overrides,
  };
}

describe('extendedEditorPath', () => {
  it('sanitizes reserved/colon characters and composes dir/file from record, field, plugin', () => {
    const path = extendedEditorPath('/tmp/root', 'Deacon [000123:Fallout4.esm]', 'Description', 'Fallout4.esm');
    // Brackets are valid on every platform's filesystem — only the FormKey's colon (a
    // Windows-reserved character) needs replacing.
    expect(path).toBe(join('/tmp/root', 'Deacon [000123_Fallout4.esm]', 'Description [Fallout4.esm].txt'));
  });

  it('is deterministic — the same identity always produces the same path', () => {
    const a = extendedEditorPath('/tmp/root', 'Deacon [000123:Fallout4.esm]', 'Description', 'Fallout4.esm');
    const b = extendedEditorPath('/tmp/root', 'Deacon [000123:Fallout4.esm]', 'Description', 'Fallout4.esm');
    expect(a).toBe(b);
  });

  // Issue #242: a pending cell and its disk companion share record+field+plugin exactly (a
  // pending column only ever exists alongside a disk column for the same plugin) — without a
  // fourth discriminant, opening one would silently reuse/reseed the other's already-open tab.
  it('a pending cell path differs from its disk companion, given identical record+field+plugin', () => {
    const disk = extendedEditorPath('/tmp/root', 'Deacon', 'Description', 'Fallout4.esm');
    const pending = extendedEditorPath('/tmp/root', 'Deacon', 'Description', 'Fallout4.esm', 'pending');
    expect(pending).not.toBe(disk);
  });

  it('the pending path stays in the same record directory, suffixed on the filename only', () => {
    const pending = extendedEditorPath('/tmp/root', 'Deacon', 'Description', 'Fallout4.esm', 'pending');
    expect(pending).toBe(join('/tmp/root', 'Deacon', 'Description [Fallout4.esm] (Pending).txt'));
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
    const path = extendedEditorPath(tempRoot, 'Deacon [000123:Fallout4.esm]', 'Description', 'Fallout4.esm');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path }, getText: () => 'a long description' });

    await openExtendedFieldEditor(
      { requestId: 'r1', value: 'a long description', recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Description', plugin: 'Fallout4.esm', readOnly: false },
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
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path }, getText: () => 'x' });

    await openExtendedFieldEditor(
      { requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', readOnly: false },
      makeDeps(tempRoot),
    );

    const mode = (await stat(path)).mode & 0o777;
    expect(mode & 0o200).not.toBe(0); // owner-write bit set
  });

  // AC5 / seam: immutable columns get a read-only tab, not an absent one — enforced by the OS
  // permission bit, which is the same mechanism VS Code's own read-only file detection reads.
  it('marks an immutable (readOnly) temp file non-writable', async () => {
    const tempRoot = await makeTempRoot();
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path }, getText: () => 'x' });

    await openExtendedFieldEditor(
      { requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', readOnly: true },
      makeDeps(tempRoot),
    );

    const mode = (await stat(path)).mode & 0o777;
    expect(mode & 0o200).toBe(0); // owner-write bit cleared
  });

  // AC4: committing from it stages through the same path as any other edit — each save posts
  // EXTENDED_EDITOR_COMMITTED with the saved content, correlated by requestId.
  it('replies with EXTENDED_EDITOR_COMMITTED carrying the saved content when the doc is saved', async () => {
    const tempRoot = await makeTempRoot();
    const saveEvent = makeFakeDocEvent();
    onDidSaveTextDocument.mockImplementation(saveEvent.register);
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    const deps = makeDeps(tempRoot);

    await openExtendedFieldEditor(
      { requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', readOnly: false },
      deps,
    );
    saveEvent.fire({ uri: { fsPath: path }, getText: () => 'first save' });
    saveEvent.fire({ uri: { fsPath: path }, getText: () => 'second save' });

    expect(deps.reply).toHaveBeenNthCalledWith(1, { type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED, requestId: 'r1', value: 'first save' });
    expect(deps.reply).toHaveBeenNthCalledWith(2, { type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED, requestId: 'r1', value: 'second save' });
  });

  it('ignores a save event for a different document', async () => {
    const tempRoot = await makeTempRoot();
    const saveEvent = makeFakeDocEvent();
    onDidSaveTextDocument.mockImplementation(saveEvent.register);
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    const deps = makeDeps(tempRoot);

    await openExtendedFieldEditor(
      { requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', readOnly: false },
      deps,
    );
    saveEvent.fire({ uri: { fsPath: '/some/other/file.txt' }, getText: () => 'unrelated' });

    expect(deps.reply).not.toHaveBeenCalled();
  });

  // Seam addition (coordinator): closing must delete the temp file, dispose both listeners, and
  // notify the webview so nativeBridge can drop its own requestId -> onCommit bookkeeping —
  // a save-then-close-without-further-saves must not leak an entry per tab ever opened.
  it('on close: deletes the temp file, disposes both listeners, and replies EXTENDED_EDITOR_CLOSED', async () => {
    const tempRoot = await makeTempRoot();
    const saveEvent = makeFakeDocEvent();
    const closeEvent = makeFakeDocEvent();
    onDidSaveTextDocument.mockImplementation(saveEvent.register);
    onDidCloseTextDocument.mockImplementation(closeEvent.register);
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    const deps = makeDeps(tempRoot);

    await openExtendedFieldEditor(
      { requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', readOnly: false },
      deps,
    );
    closeEvent.fire({ uri: { fsPath: path }, getText: () => 'x' });
    // unlink is fire-and-forget inside the handler — flush microtasks before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_CLOSED, requestId: 'r1' });
    expect(saveEvent.isDisposed()).toBe(true);
    expect(closeEvent.isDisposed()).toBe(true);
    await expect(stat(path)).rejects.toThrow();
  });

  // Review fix (finding #2): the nativeBridge requestId -> onCommit map entry is registered
  // optimistically, before any reply exists — if the open itself fails, no tab (and so no
  // onDidCloseTextDocument) ever exists to send the cleanup signal the normal way. Without this,
  // that map entry would leak forever. Reusing EXTENDED_EDITOR_CLOSED (rather than a distinct
  // failure message) means nativeBridge needs no second cleanup path — it already deletes on this
  // message (see nativeBridge.test.ts's "stops calling onCommit once EXTENDED_EDITOR_CLOSED
  // arrives"), so this test only needs to prove the host actually sends it on this path too.
  it('reports an error, does not throw, and still replies EXTENDED_EDITOR_CLOSED when opening fails', async () => {
    const deps = makeDeps('/nonexistent-root-\0-invalid');

    await expect(openExtendedFieldEditor(
      { requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', readOnly: false },
      deps,
    )).resolves.toBeUndefined();

    expect(deps.reporter.report).toHaveBeenCalledWith('error', 'Could not open the extended editor.', expect.any(String));
    expect(deps.reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_CLOSED, requestId: 'r1' });
  });

  // Review fix (finding #1): the path is deterministic, so double-clicking the same immutable
  // cell twice (or re-double-clicking a cell whose tab is still open) reopens the *same* file —
  // one already chmod'ed 0o444 by the first open. Without forcing it writable before the second
  // open's own writeFile, that write throws EACCES, caught and swallowed into the generic error
  // toast — silently breaking "re-double-clicking reveals the already-open tab" specifically on
  // the immutable path.
  it('a second open of the same immutable cell succeeds identically to the first (no EACCES)', async () => {
    const tempRoot = await makeTempRoot();
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path }, getText: () => 'x' });
    const params = { requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', readOnly: true };

    const firstDeps = makeDeps(tempRoot);
    await openExtendedFieldEditor(params, firstDeps);
    expect(firstDeps.reporter.report).not.toHaveBeenCalled();

    const secondDeps = makeDeps(tempRoot);
    await openExtendedFieldEditor({ ...params, requestId: 'r2' }, secondDeps);

    expect(secondDeps.reporter.report).not.toHaveBeenCalled();
    const mode = (await stat(path)).mode & 0o777;
    expect(mode & 0o200).toBe(0); // still read-only after the second open
  });

  // Issue #242 (AC2): a pending cell and its disk companion share record+field+plugin exactly —
  // opening both must land on two distinct files, each holding its own value, not one silently
  // reseeding the other. Proves the independence at openExtendedFieldEditor's own boundary (the
  // path-level discriminant is extendedEditorPath's own test above).
  it('a pending cell and its disk companion open independent temp files for the same record+field+plugin', async () => {
    const tempRoot = await makeTempRoot();
    const diskPath = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm');
    const pendingPath = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'pending');
    openTextDocument.mockImplementation((uri: { fsPath: string }) => Promise.resolve({ uri, getText: () => '' }));

    await openExtendedFieldEditor(
      { requestId: 'r1', value: 'disk value', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', readOnly: false },
      makeDeps(tempRoot),
    );
    await openExtendedFieldEditor(
      { requestId: 'r2', value: 'pending value', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', readOnly: false, column: 'pending' },
      makeDeps(tempRoot),
    );

    expect(diskPath).not.toBe(pendingPath);
    expect(await readFile(diskPath, 'utf8')).toBe('disk value');
    expect(await readFile(pendingPath, 'utf8')).toBe('pending value');
  });

  // Review fix (finding #3): AC3's "multi-line string values can be read and edited in full"
  // claim was untested — every other fixture in this suite is single-line. writeFile/getText are
  // content-agnostic in principle, but VS Code's own EOL-normalization/insertFinalNewline on save
  // is exactly the kind of thing that could silently alter a value with embedded newlines, so
  // this exercises the full write -> save -> commit path with one and asserts the committed value
  // is byte-for-byte what was saved, no newline added or stripped.
  it('a multi-line value survives the full write -> save -> commit path unchanged', async () => {
    const tempRoot = await makeTempRoot();
    const saveEvent = makeFakeDocEvent();
    onDidSaveTextDocument.mockImplementation(saveEvent.register);
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm');
    const multiline = 'First line.\nSecond line.\n\nFourth line, after a blank one.';
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    const deps = makeDeps(tempRoot);

    await openExtendedFieldEditor(
      { requestId: 'r1', value: multiline, recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', readOnly: false },
      deps,
    );
    // The initial write is what the tab opens showing — prove it round-trips before the save.
    expect(await readFile(path, 'utf8')).toBe(multiline);

    const edited = `${multiline}\nA fifth line, added in the editor.`;
    saveEvent.fire({ uri: { fsPath: path }, getText: () => edited });

    expect(deps.reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED, requestId: 'r1', value: edited });
  });
});
