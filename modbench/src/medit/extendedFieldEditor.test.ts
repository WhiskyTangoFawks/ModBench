import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Same "mock vscode, use real fs against a throwaway tmpdir" shape
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
    // Awaits every listener's returned promise (an async listener's fs cleanup included), so a
    // test observes the handler *finished*, not merely started — the delete/stat race of #651.
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
    reply: vi.fn(),
    log: vi.fn(),
    reporter: { report: vi.fn() },
    ...overrides,
  };
}

describe('extendedEditorPath', () => {
  it('sanitizes reserved/colon characters and composes dir/origin/file from record, field, plugin', () => {
    const path = extendedEditorPath('/tmp/root', 'Deacon [000123:Fallout4.esm]', 'Description', 'Fallout4.esm', 'Data');
    // Brackets are valid on every platform's filesystem — only the FormKey's colon (a
    // Windows-reserved character) needs replacing.
    expect(path).toBe(join('/tmp/root', 'Deacon [000123_Fallout4.esm]', 'Data', 'Description [Fallout4.esm].txt'));
  });

  it('is deterministic — the same identity always produces the same path', () => {
    const a = extendedEditorPath('/tmp/root', 'Deacon [000123:Fallout4.esm]', 'Description', 'Fallout4.esm', 'Data');
    const b = extendedEditorPath('/tmp/root', 'Deacon [000123:Fallout4.esm]', 'Description', 'Fallout4.esm', 'Data');
    expect(a).toBe(b);
  });

  // ADR-0036: origin folds into the path unconditionally (no "elide Data" branch) — the
  // directory is never what the user reads (the tab title is the filename alone, unchanged), so
  // there is nothing to keep quiet for the common single-origin case, and no collision-dependent
  // rule to get wrong.
  it('folds a non-Data origin into its own directory segment, between the record and the field', () => {
    const path = extendedEditorPath('/tmp/root', 'Deacon', 'Description', 'Shared.esp', 'ModA');
    expect(path).toBe(join('/tmp/root', 'Deacon', 'ModA', 'Description [Shared.esp].txt'));
  });

  // Two loaded columns sharing a filename (ADR-0036)
  // must never resolve to the same temp file — origin is the only thing left that tells them
  // apart, since record+field+plugin+column are identical for both.
  it('two columns sharing a filename but differing in origin never collide', () => {
    const colA = extendedEditorPath('/tmp/root', 'Deacon', 'Description', 'Shared.esp', 'ModA');
    const colB = extendedEditorPath('/tmp/root', 'Deacon', 'Description', 'Shared.esp', 'ModB');
    expect(colA).not.toBe(colB);
  });

  // Origin is a mod folder name, read off disk — an MO2 instance is user-controlled
  // input, not a trusted literal, and this is the one component where getting sanitization wrong
  // writes outside tempRoot. sanitizeForPath's regex (`/[<>:"/\\|?*]/g`) already strips every path
  // separator, so `..` alone (no `/` or `\` around it) can never traverse — mirrors the coverage
  // recordLabel/fieldName/plugin already get from the reserved-character test above, extended to
  // the fourth segment.
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
      { requestId: 'r1', value: 'a long description', recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: false },
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
      { requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: false },
      makeDeps(tempRoot),
    );

    const mode = (await stat(path)).mode & 0o777;
    expect(mode & 0o200).not.toBe(0); // owner-write bit set
  });

  // Immutable columns get a read-only tab, not an absent one — enforced by the OS
  // permission bit, which is the same mechanism VS Code's own read-only file detection reads.
  it('marks an immutable (readOnly) temp file non-writable', async () => {
    const tempRoot = await makeTempRoot();
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path }, getText: () => 'x' });

    await openExtendedFieldEditor(
      { requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: true },
      makeDeps(tempRoot),
    );

    const mode = (await stat(path)).mode & 0o777;
    expect(mode & 0o200).toBe(0); // owner-write bit cleared
  });

  // Committing from it writes through the same path as any other edit — each save posts
  // EXTENDED_EDITOR_COMMITTED with the saved content, correlated by requestId.
  it('replies with EXTENDED_EDITOR_COMMITTED carrying the saved content when the doc is saved', async () => {
    const tempRoot = await makeTempRoot();
    const saveEvent = makeFakeDocEvent();
    onDidSaveTextDocument.mockImplementation(saveEvent.register);
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    const deps = makeDeps(tempRoot);

    await openExtendedFieldEditor(
      { requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: false },
      deps,
    );
    await saveEvent.fire({ uri: { fsPath: path }, getText: () => 'first save' });
    await saveEvent.fire({ uri: { fsPath: path }, getText: () => 'second save' });

    expect(deps.reply).toHaveBeenNthCalledWith(1, { type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED, requestId: 'r1', value: 'first save' });
    expect(deps.reply).toHaveBeenNthCalledWith(2, { type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED, requestId: 'r1', value: 'second save' });
  });

  it('ignores a save event for a different document', async () => {
    const tempRoot = await makeTempRoot();
    const saveEvent = makeFakeDocEvent();
    onDidSaveTextDocument.mockImplementation(saveEvent.register);
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    const deps = makeDeps(tempRoot);

    await openExtendedFieldEditor(
      { requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: false },
      deps,
    );
    await saveEvent.fire({ uri: { fsPath: '/some/other/file.txt' }, getText: () => 'unrelated' });

    expect(deps.reply).not.toHaveBeenCalled();
  });

  // Closing must delete the temp file, dispose both listeners, and
  // notify the webview so nativeBridge can drop its own requestId -> onCommit bookkeeping —
  // a save-then-close-without-further-saves must not leak an entry per tab ever opened.
  it('on close: deletes the temp file, disposes both listeners, and replies EXTENDED_EDITOR_CLOSED', async () => {
    const tempRoot = await makeTempRoot();
    const saveEvent = makeFakeDocEvent();
    const closeEvent = makeFakeDocEvent();
    onDidSaveTextDocument.mockImplementation(saveEvent.register);
    onDidCloseTextDocument.mockImplementation(closeEvent.register);
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    const deps = makeDeps(tempRoot);

    await openExtendedFieldEditor(
      { requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: false },
      deps,
    );
    await closeEvent.fire({ uri: { fsPath: path }, getText: () => 'x' });

    expect(deps.reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_CLOSED, requestId: 'r1' });
    expect(saveEvent.isDisposed()).toBe(true);
    expect(closeEvent.isDisposed()).toBe(true);
    await expect(stat(path)).rejects.toThrow();
  });

  // The nativeBridge requestId -> onCommit map entry is registered
  // optimistically, before any reply exists — if the open itself fails, no tab (and so no
  // onDidCloseTextDocument) ever exists to send the cleanup signal the normal way. Without this,
  // that map entry would leak forever. Reusing EXTENDED_EDITOR_CLOSED (rather than a distinct
  // failure message) means nativeBridge needs no second cleanup path — it already deletes on this
  // message (see nativeBridge.test.ts's "stops calling onCommit once EXTENDED_EDITOR_CLOSED
  // arrives"), so this test only needs to prove the host actually sends it on this path too.
  it('reports an error, does not throw, and still replies EXTENDED_EDITOR_CLOSED when opening fails', async () => {
    const deps = makeDeps('/nonexistent-root-\0-invalid');

    await expect(openExtendedFieldEditor(
      { requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: false },
      deps,
    )).resolves.toBeUndefined();

    expect(deps.reporter.report).toHaveBeenCalledWith('error', 'Could not open the extended editor.', expect.any(String));
    expect(deps.reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_CLOSED, requestId: 'r1' });
  });

  // The path is deterministic, so double-clicking the same immutable
  // cell twice (or re-double-clicking a cell whose tab is still open) reopens the *same* file —
  // one already chmod'ed 0o444 by the first open. Without forcing it writable before the second
  // open's own writeFile, that write throws EACCES, caught and swallowed into the generic error
  // toast — silently breaking "re-double-clicking reveals the already-open tab" specifically on
  // the immutable path.
  it('a second open of the same immutable cell succeeds identically to the first (no EACCES)', async () => {
    const tempRoot = await makeTempRoot();
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path }, getText: () => 'x' });
    const params = { requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: true };

    const firstDeps = makeDeps(tempRoot);
    await openExtendedFieldEditor(params, firstDeps);
    expect(firstDeps.reporter.report).not.toHaveBeenCalled();

    const secondDeps = makeDeps(tempRoot);
    await openExtendedFieldEditor({ ...params, requestId: 'r2' }, secondDeps);

    expect(secondDeps.reporter.report).not.toHaveBeenCalled();
    const mode = (await stat(path)).mode & 0o777;
    expect(mode & 0o200).toBe(0); // still read-only after the second open
  });

  // ADR-0036: two loaded columns sharing a filename (ModA's Shared.esp and ModB's Shared.esp)
  // must not resolve to one temp file — a second open would silently overwrite the first's content
  // ("right target, wrong content" — the commit closure is still bound correctly per-column, only
  // what the user *sees* while editing would be wrong).
  it('two columns sharing a filename but differing in origin open independent temp files', async () => {
    const tempRoot = await makeTempRoot();
    const colAPath = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Shared.esp', 'ModA');
    const colBPath = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Shared.esp', 'ModB');
    openTextDocument.mockImplementation((uri: { fsPath: string }) => Promise.resolve({ uri, getText: () => '' }));

    await openExtendedFieldEditor(
      { requestId: 'r1', value: 'from ModA', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Shared.esp', origin: 'ModA', readOnly: false },
      makeDeps(tempRoot),
    );
    await openExtendedFieldEditor(
      { requestId: 'r2', value: 'from ModB', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Shared.esp', origin: 'ModB', readOnly: false },
      makeDeps(tempRoot),
    );

    expect(colAPath).not.toBe(colBPath);
    expect(await readFile(colAPath, 'utf8')).toBe('from ModA');
    expect(await readFile(colBPath, 'utf8')).toBe('from ModB');
  });

  // Origin is read off disk (a mod folder name), not a trusted literal — proves the
  // real write, not just the computed string, stays under tempRoot for a hostile value.
  it('a hostile origin cannot make the write land outside tempRoot', async () => {
    const tempRoot = await makeTempRoot();
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', '../../../etc/passwd');
    openTextDocument.mockResolvedValue({ uri: { fsPath: path }, getText: () => 'x' });

    await openExtendedFieldEditor(
      { requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: '../../../etc/passwd', readOnly: false },
      makeDeps(tempRoot),
    );

    expect(path.startsWith(tempRoot)).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('x');
  });

  // Multi-line string values must be readable and editable in full —
  // every other fixture in this suite is single-line. writeFile/getText are
  // content-agnostic in principle, but VS Code's own EOL-normalization/insertFinalNewline on save
  // is exactly the kind of thing that could silently alter a value with embedded newlines, so
  // this exercises the full write -> save -> commit path with one and asserts the committed value
  // is byte-for-byte what was saved, no newline added or stripped.
  it('a multi-line value survives the full write -> save -> commit path unchanged', async () => {
    const tempRoot = await makeTempRoot();
    const saveEvent = makeFakeDocEvent();
    onDidSaveTextDocument.mockImplementation(saveEvent.register);
    const path = extendedEditorPath(tempRoot, 'Deacon', 'Description', 'Fallout4.esm', 'Data');
    const multiline = 'First line.\nSecond line.\n\nFourth line, after a blank one.';
    openTextDocument.mockResolvedValue({ uri: { fsPath: path } });
    const deps = makeDeps(tempRoot);

    await openExtendedFieldEditor(
      { requestId: 'r1', value: multiline, recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: false },
      deps,
    );
    // The initial write is what the tab opens showing — prove it round-trips before the save.
    expect(await readFile(path, 'utf8')).toBe(multiline);

    const edited = `${multiline}\nA fifth line, added in the editor.`;
    await saveEvent.fire({ uri: { fsPath: path }, getText: () => edited });

    expect(deps.reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED, requestId: 'r1', value: edited });
  });
});
