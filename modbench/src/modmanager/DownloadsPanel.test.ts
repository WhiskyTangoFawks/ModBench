import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { executeCommand, registerCommand, showWarningMessage, showErrorMessage, showTextDocument, showQuickPick, openExternal, fsDelete } = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showTextDocument: vi.fn(),
  showQuickPick: vi.fn(),
  openExternal: vi.fn(),
  fsDelete: vi.fn(),
}));

vi.mock('vscode', () => ({
  commands: { executeCommand, registerCommand },
  window: { showWarningMessage, showErrorMessage, showTextDocument, showQuickPick },
  env: { openExternal },
  workspace: { fs: { delete: fsDelete } },
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
    parse: (s: string) => ({ toString: () => s }),
  },
  ViewColumn: { One: 1 },
}));

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteArchives,
  registerDownloadsHiddenToggleCommands,
  registerDownloadsMultiRowCommands,
  registerDownloadsSingleRowCommands,
  registerDownloadsSortCommand,
} from './DownloadsPanel';
import type { DownloadNode, DownloadsProvider } from './DownloadsProvider';

/** A minimal stand-in for a tree row — only `row.name` is read by anything under test here,
 *  so a real vscode.TreeItem-backed DownloadNode isn't needed in this file. */
const node = (name: string): DownloadNode => ({ row: { name } } as DownloadNode);

/** A minimal stand-in for DownloadsProvider — only setSort/setShowHidden are called by
 *  anything under test here, so a real fs-backed DownloadsProvider isn't needed in this file. */
const fakeDownloadsProvider = (): DownloadsProvider & { setSort: ReturnType<typeof vi.fn>; setShowHidden: ReturnType<typeof vi.fn> } =>
  ({ setSort: vi.fn(), setShowHidden: vi.fn() } as unknown as DownloadsProvider & { setSort: ReturnType<typeof vi.fn>; setShowHidden: ReturnType<typeof vi.fn> });

// tmpdirs created via makeInstanceRoot() this test, cleaned up in afterEach even
// if the test fails partway through (an inline rm() at the end of a test body
// would be skipped by a failed assertion above it and leak the tmpdir).
let instanceRoots: string[] = [];

afterEach(async () => {
  await Promise.all(instanceRoots.map((root) => rm(root, { recursive: true, force: true })));
  instanceRoots = [];
});

/** Fresh MO2-instance-shaped tmpdir with a downloads/ folder, for handlers that
 *  touch the filesystem. Caller writes archive/.meta fixtures as needed. */
async function makeInstanceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'downloads-panel-'));
  await mkdir(join(root, 'downloads'), { recursive: true });
  instanceRoots.push(root);
  return root;
}

/** Write an archive fixture under `<root>/downloads/<name>`. */
async function writeArchive(root: string, name: string, data = 'data'): Promise<string> {
  const path = join(root, 'downloads', name);
  await writeFile(path, data);
  return path;
}

/** Write a `.meta` sidecar fixture for `<root>/downloads/<name>`. */
async function writeMeta(root: string, name: string, text = '[General]\r\n'): Promise<string> {
  const path = join(root, 'downloads', `${name}.meta`);
  await writeFile(path, text);
  return path;
}

/** First positional arg's `fsPath` from a mocked vscode call, e.g.
 *  `openExternal(uri)` — reduces repeated inline casts across nav-action tests. */
function calledFsPath(mockFn: { mock: { calls: unknown[][] } }): string {
  return (mockFn.mock.calls[0][0] as { fsPath: string }).fsPath;
}

/** Invoke a command registered via the mocked `vscode.commands.registerCommand` by id — the
 *  real captured callback, not a handler reached by any other path. Every behavior test in this
 *  file goes through this, so each one exercises the actual production wiring (the node?
 *  null-guard, `selectionNames`' selection-collapsing) along with the action itself. */
function invoke(commandId: string, ...args: unknown[]): void {
  const call = registerCommand.mock.calls.find((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  call[1](...args);
}

// ── registerDownloadsSingleRowCommands ──────────────────────────────────────
// Install / Visit on Nexus / Open File / Open Meta File: clicked-row-only commands, each
// registered as a direct vscode.commands.registerCommand call (no id->handler lookup table).
// Registration itself (that all 7 ids get wired to vscode.commands.registerCommand) is also
// covered by the EXPECTED_COMMANDS integration test; these are the dispatch/gating/behavior.

describe('registerDownloadsSingleRowCommands', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers Install / Visit on Nexus / Open File / Open Meta File', () => {
    registerDownloadsSingleRowCommands('/instance', vi.fn());
    const ids = registerCommand.mock.calls.map((c) => c[0]);
    expect(ids).toEqual(expect.arrayContaining([
      'modbench.downloads.install',
      'modbench.downloads.visitNexus',
      'modbench.downloads.openFile',
      'modbench.downloads.openMeta',
    ]));
    expect(ids).not.toContain('modbench.downloads.reveal');
  });

  it('invoking modbench.downloads.install with a DownloadNode installs that row\'s archive', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    await writeMeta(root, 'foo.7z');
    executeCommand.mockResolvedValueOnce(true);

    registerDownloadsSingleRowCommands(root, vi.fn());
    invoke('modbench.downloads.install', node('foo.7z'));

    await vi.waitFor(() => {
      expect(executeCommand).toHaveBeenCalledWith('modbench.modList.installFromArchive', archive);
    });
  });

  it('is a no-op when invoked with no node (no row to act on)', () => {
    registerDownloadsSingleRowCommands('/instance', vi.fn());
    expect(() => invoke('modbench.downloads.install', undefined)).not.toThrow();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('ignores the rest of a multi-selection — only the clicked row is installed', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    await writeArchive(root, 'other.7z');
    await writeMeta(root, 'foo.7z');
    executeCommand.mockResolvedValueOnce(true);

    registerDownloadsSingleRowCommands(root, vi.fn());
    invoke('modbench.downloads.install', node('foo.7z'), [node('foo.7z'), node('other.7z')]);

    await vi.waitFor(() => {
      expect(executeCommand).toHaveBeenCalledWith('modbench.modList.installFromArchive', archive);
    });
    expect(executeCommand).toHaveBeenCalledTimes(1);
  });

  it('install: on success, writes installed=true back to the .meta sidecar', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    executeCommand.mockResolvedValueOnce(true);

    registerDownloadsSingleRowCommands(root, vi.fn());
    invoke('modbench.downloads.install', node('foo.7z'));

    await vi.waitFor(async () => {
      expect(await readFile(meta, 'utf8')).toContain('installed=true');
    });
    expect(executeCommand).toHaveBeenCalledWith('modbench.modList.installFromArchive', archive);
  });

  it('install: when the install command reports cancellation, leaves the .meta untouched', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    executeCommand.mockResolvedValueOnce(false);

    registerDownloadsSingleRowCommands(root, vi.fn());
    invoke('modbench.downloads.install', node('foo.7z'));

    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalled());
    // give any (incorrect) writeback a chance to land before asserting its absence
    await new Promise((r) => setTimeout(r, 50));
    expect(await readFile(meta, 'utf8')).not.toContain('installed=true');
  });

  it('install: when the install command throws, surfaces an error and leaves the .meta untouched', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    executeCommand.mockRejectedValueOnce(new Error('boom'));
    const log = vi.fn();

    registerDownloadsSingleRowCommands(root, log);
    invoke('modbench.downloads.install', node('foo.7z'));

    await vi.waitFor(() => expect(showErrorMessage).toHaveBeenCalled());
    expect(showErrorMessage).toHaveBeenCalledWith('Modbench: Failed to install "foo.7z".');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('installing "foo.7z" failed'));
    expect(await readFile(meta, 'utf8')).not.toContain('installed=true');
  });

  it('visitNexus: opens the Nexus mod page when the .meta has a modID', async () => {
    const root = await makeInstanceRoot();
    await writeMeta(root, 'foo.7z', '[General]\r\nmodID=123\r\n');
    await writeFile(join(root, 'ModOrganizer.ini'), '[General]\r\ngameName=Fallout4\r\n');

    registerDownloadsSingleRowCommands(root, vi.fn());
    invoke('modbench.downloads.visitNexus', node('foo.7z'));

    await vi.waitFor(() => expect(openExternal).toHaveBeenCalled());
    const url = (openExternal.mock.calls[0][0] as { toString(): string }).toString();
    expect(url).toBe('https://www.nexusmods.com/fallout4/mods/123');
  });

  it('visitNexus: is a no-op when the .meta has no modID', async () => {
    const root = await makeInstanceRoot();
    await writeMeta(root, 'foo.7z');

    registerDownloadsSingleRowCommands(root, vi.fn());
    invoke('modbench.downloads.visitNexus', node('foo.7z'));

    await new Promise((r) => setTimeout(r, 50));
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('openFile: OS-opens the archive', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');

    registerDownloadsSingleRowCommands(root, vi.fn());
    invoke('modbench.downloads.openFile', node('foo.7z'));

    await vi.waitFor(() => expect(openExternal).toHaveBeenCalled());
    expect(calledFsPath(openExternal)).toBe(archive);
  });

  it('openMeta: opens the .meta sidecar in the editor', async () => {
    const root = await makeInstanceRoot();
    const meta = await writeMeta(root, 'foo.7z');

    registerDownloadsSingleRowCommands(root, vi.fn());
    invoke('modbench.downloads.openMeta', node('foo.7z'));

    await vi.waitFor(() => expect(showTextDocument).toHaveBeenCalled());
    expect(calledFsPath(showTextDocument)).toBe(meta);
  });

  // runRowAction's catch -> log + error-notification path is shared by both nav actions
  // (visitNexus/openFile/openMeta) — proving it once here (via openFile) covers all of them;
  // no need to duplicate per action.
  it('nav actions: on failure, logs and surfaces an error notification naming the action and row', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    openExternal.mockRejectedValueOnce(new Error('no handler for this file type'));
    const log = vi.fn();

    registerDownloadsSingleRowCommands(root, log);
    invoke('modbench.downloads.openFile', node('foo.7z'));

    await vi.waitFor(() => expect(showErrorMessage).toHaveBeenCalled());
    expect(showErrorMessage).toHaveBeenCalledWith('Modbench: Open File for "foo.7z" failed.');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Open File for "foo.7z" failed'));
  });
});

describe('registerDownloadsMultiRowCommands', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers Delete / Hide / Unhide', () => {
    registerDownloadsMultiRowCommands('/instance', vi.fn());
    const ids = registerCommand.mock.calls.map((c) => c[0]);
    expect(ids).toEqual(expect.arrayContaining([
      'modbench.downloads.delete',
      'modbench.downloads.hide',
      'modbench.downloads.unhide',
    ]));
  });

  it('hide applies to the whole selection, not just the clicked row', async () => {
    const root = await makeInstanceRoot();
    const metaA = await writeMeta(root, 'a.7z');
    const metaB = await writeMeta(root, 'b.7z');

    registerDownloadsMultiRowCommands(root, vi.fn());
    invoke('modbench.downloads.hide', node('a.7z'), [node('a.7z'), node('b.7z')]);

    await vi.waitFor(async () => {
      expect(await readFile(metaA, 'utf8')).toContain('removed=true');
      expect(await readFile(metaB, 'utf8')).toContain('removed=true');
    });
  });

  it('is idempotent over a mixed hidden/visible selection — hide leaves both hidden, no error', async () => {
    const root = await makeInstanceRoot();
    const already = await writeMeta(root, 'already-hidden.7z', '[General]\r\nremoved=true\r\n');
    const visible = await writeMeta(root, 'visible.7z');

    registerDownloadsMultiRowCommands(root, vi.fn());
    invoke('modbench.downloads.hide', node('visible.7z'), [node('already-hidden.7z'), node('visible.7z')]);

    await vi.waitFor(async () => {
      expect(await readFile(already, 'utf8')).toContain('removed=true');
      expect(await readFile(visible, 'utf8')).toContain('removed=true');
    });
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('is idempotent over a mixed selection for unhide too — both end up unhidden, no error', async () => {
    const root = await makeInstanceRoot();
    const hidden = await writeMeta(root, 'hidden.7z', '[General]\r\nremoved=true\r\n');
    const already = await writeMeta(root, 'already-visible.7z');

    registerDownloadsMultiRowCommands(root, vi.fn());
    invoke('modbench.downloads.unhide', node('hidden.7z'), [node('hidden.7z'), node('already-visible.7z')]);

    await vi.waitFor(async () => {
      expect(await readFile(hidden, 'utf8')).toContain('removed=false');
      expect(await readFile(already, 'utf8')).toContain('removed=false');
    });
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('hide: sets removed=true on the .meta sidecar (clicked row alone, no selection array)', async () => {
    const root = await makeInstanceRoot();
    const meta = await writeMeta(root, 'foo.7z');

    registerDownloadsMultiRowCommands(root, vi.fn());
    invoke('modbench.downloads.hide', node('foo.7z'));

    await vi.waitFor(async () => {
      expect(await readFile(meta, 'utf8')).toContain('removed=true');
    });
  });

  it('unhide: clears removed to false on the .meta sidecar (clicked row alone, no selection array)', async () => {
    const root = await makeInstanceRoot();
    const meta = await writeMeta(root, 'foo.7z', '[General]\r\nremoved=true\r\n');

    registerDownloadsMultiRowCommands(root, vi.fn());
    invoke('modbench.downloads.unhide', node('foo.7z'));

    await vi.waitFor(async () => {
      expect(await readFile(meta, 'utf8')).toContain('removed=false');
    });
  });

  it('delete falls back to the clicked row alone when no selection array is passed', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    showWarningMessage.mockResolvedValueOnce('Delete');

    registerDownloadsMultiRowCommands(root, vi.fn());
    invoke('modbench.downloads.delete', node('foo.7z'));

    await vi.waitFor(() => expect(fsDelete).toHaveBeenCalledTimes(1));
    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('"foo.7z"'),
      { modal: true },
      'Delete',
    );
  });

  // The negative case on a destructive operation — the single most valuable assertion in this
  // group: declining the confirmation must trash nothing.
  it('delete: on confirm-cancel, does not trash anything', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    showWarningMessage.mockResolvedValueOnce(undefined); // user dismissed, not "Delete"

    registerDownloadsMultiRowCommands(root, vi.fn());
    invoke('modbench.downloads.delete', node('foo.7z'));

    await vi.waitFor(() => expect(showWarningMessage).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(fsDelete).not.toHaveBeenCalled();
  });

  it('delete: on confirm-accept, trashes the archive (and its .meta, if present)', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    showWarningMessage.mockResolvedValueOnce('Delete');

    registerDownloadsMultiRowCommands(root, vi.fn());
    invoke('modbench.downloads.delete', node('foo.7z'));

    await vi.waitFor(() => expect(fsDelete).toHaveBeenCalledTimes(2));
    const trashedPaths = fsDelete.mock.calls.map((c) => (c[0] as { fsPath: string }).fsPath);
    expect(trashedPaths).toEqual(expect.arrayContaining([archive, meta]));
  });
});

// ── deleteArchives — batch delete confirmation ──────────────────────────────
describe('deleteArchives', () => {
  beforeEach(() => vi.clearAllMocks());

  it('confirms once for the whole batch, then trashes every archive (+ its .meta, if present)', async () => {
    const root = await makeInstanceRoot();
    const a = await writeArchive(root, 'a.7z');
    const b = await writeArchive(root, 'b.7z');
    await writeMeta(root, 'a.7z');
    showWarningMessage.mockResolvedValueOnce('Delete');

    await deleteArchives(root, ['a.7z', 'b.7z'], vi.fn());

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('2 items'),
      { modal: true },
      'Delete',
    );
    const trashedPaths = fsDelete.mock.calls.map((c) => (c[0] as { fsPath: string }).fsPath);
    expect(trashedPaths).toEqual(expect.arrayContaining([a, b]));
  });

  it('on cancel, trashes nothing', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'a.7z');
    await writeArchive(root, 'b.7z');
    showWarningMessage.mockResolvedValueOnce(undefined);

    await deleteArchives(root, ['a.7z', 'b.7z'], vi.fn());

    expect(fsDelete).not.toHaveBeenCalled();
  });

  it('a single-item batch reuses the singular per-file confirmation text', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    showWarningMessage.mockResolvedValueOnce('Delete');

    await deleteArchives(root, ['foo.7z'], vi.fn());

    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('"foo.7z"'),
      { modal: true },
      'Delete',
    );
  });
});

// ── registerDownloadsSortCommand ─────────────────────────────────────────────

describe('registerDownloadsSortCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers modbench.downloads.sortBy', () => {
    registerDownloadsSortCommand(fakeDownloadsProvider());
    expect(registerCommand.mock.calls.map((c) => c[0])).toContain('modbench.downloads.sortBy');
  });

  it('applies the picked option to DownloadsProvider.setSort', async () => {
    const provider = fakeDownloadsProvider();
    showQuickPick.mockResolvedValueOnce({ label: 'Size (Largest First)', column: 'size', descending: true });

    registerDownloadsSortCommand(provider);
    invoke('modbench.downloads.sortBy');

    await vi.waitFor(() => {
      expect(provider.setSort).toHaveBeenCalledWith('size', true);
    });
  });

  it('does nothing when the pick is cancelled', async () => {
    const provider = fakeDownloadsProvider();
    showQuickPick.mockResolvedValueOnce(undefined);

    registerDownloadsSortCommand(provider);
    invoke('modbench.downloads.sortBy');

    await vi.waitFor(() => {
      expect(showQuickPick).toHaveBeenCalled();
    });
    expect(provider.setSort).not.toHaveBeenCalled();
  });
});

// ── registerDownloadsHiddenToggleCommands ────────────────────────────────────

describe('registerDownloadsHiddenToggleCommands', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers modbench.downloads.showHidden and .hideHidden', () => {
    registerDownloadsHiddenToggleCommands(fakeDownloadsProvider());
    expect(registerCommand.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([
      'modbench.downloads.showHidden',
      'modbench.downloads.hideHidden',
    ]));
  });

  it('showHidden turns hidden rows on and sets the context key true', () => {
    const provider = fakeDownloadsProvider();
    registerDownloadsHiddenToggleCommands(provider);

    invoke('modbench.downloads.showHidden');

    expect(provider.setShowHidden).toHaveBeenCalledWith(true);
    expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.downloads.showHidden', true);
  });

  it('hideHidden turns hidden rows off and sets the context key false', () => {
    const provider = fakeDownloadsProvider();
    registerDownloadsHiddenToggleCommands(provider);

    invoke('modbench.downloads.hideHidden');

    expect(provider.setShowHidden).toHaveBeenCalledWith(false);
    expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.downloads.showHidden', false);
  });
});
