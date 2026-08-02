import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { executeCommand, registerCommand, showWarningMessage, showErrorMessage, showTextDocument, openExternal, fsDelete } = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showTextDocument: vi.fn(),
  openExternal: vi.fn(),
  fsDelete: vi.fn(),
}));

vi.mock('vscode', () => ({
  commands: { executeCommand, registerCommand },
  window: { showWarningMessage, showErrorMessage, showTextDocument },
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
import { buildMessageHandlers, buildRowActionHandlers, dispatchWebviewMessage, registerDownloadsRowCommands } from './DownloadsPanel';
import { WEBVIEW_TO_EXTENSION } from './downloadsMessages';

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

describe('dispatchWebviewMessage', () => {
  it('routes a known message type to the matching handler', () => {
    const handlers = { foo: vi.fn() };
    dispatchWebviewMessage({ type: 'foo' }, handlers);
    expect(handlers.foo).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an unknown message type', () => {
    const handlers = { foo: vi.fn() };
    dispatchWebviewMessage({ type: 'bar' }, handlers);
    expect(handlers.foo).not.toHaveBeenCalled();
  });

  it('does nothing and does not throw for a malformed message (non-object, null, missing type)', () => {
    const handlers = { foo: vi.fn() };
    expect(() => dispatchWebviewMessage(null, handlers)).not.toThrow();
    expect(() => dispatchWebviewMessage('a string', handlers)).not.toThrow();
    expect(() => dispatchWebviewMessage({}, handlers)).not.toThrow();
    expect(handlers.foo).not.toHaveBeenCalled();
  });
});

describe('buildMessageHandlers — READY / REFRESH', () => {
  it('READY triggers a refresh', () => {
    const refresh = vi.fn(() => Promise.resolve());
    const handlers = buildMessageHandlers(refresh);
    dispatchWebviewMessage({ type: WEBVIEW_TO_EXTENSION.READY }, handlers);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('REFRESH triggers a refresh', () => {
    const refresh = vi.fn(() => Promise.resolve());
    const handlers = buildMessageHandlers(refresh);
    dispatchWebviewMessage({ type: WEBVIEW_TO_EXTENSION.REFRESH }, handlers);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

// ── buildRowActionHandlers ──────────────────────────────────────────────────
// Issue #214: these used to be reached only via buildMessageHandlers + a webview
// postMessage (the hand-drawn row menu's sole trigger). That trigger is native
// commands now (registerDownloadsRowCommands, tested further down) — the handler
// bodies themselves are unchanged, so these suites are the same real
// fixture-in/behavior-out exercises as before, just invoked directly.

describe('buildRowActionHandlers — install', () => {
  beforeEach(() => vi.clearAllMocks());

  it('on success, writes installed=true back to the .meta sidecar', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    executeCommand.mockResolvedValueOnce(true);

    const handlers = buildRowActionHandlers(root, vi.fn());
    handlers.install('foo.7z');

    await vi.waitFor(async () => {
      expect(await readFile(meta, 'utf8')).toContain('installed=true');
    });
    expect(executeCommand).toHaveBeenCalledWith('modbench.modList.installFromArchive', archive);
  });

  it('when the install command reports cancellation, leaves the .meta untouched', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    executeCommand.mockResolvedValueOnce(false);

    const handlers = buildRowActionHandlers(root, vi.fn());
    handlers.install('foo.7z');

    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalled());
    // give any (incorrect) writeback a chance to land before asserting its absence
    await new Promise((r) => setTimeout(r, 50));
    expect(await readFile(meta, 'utf8')).not.toContain('installed=true');
  });

  it('when the install command throws, surfaces an error and leaves the .meta untouched', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    executeCommand.mockRejectedValueOnce(new Error('boom'));
    const log = vi.fn();

    const handlers = buildRowActionHandlers(root, log);
    handlers.install('foo.7z');

    await vi.waitFor(() => expect(showErrorMessage).toHaveBeenCalled());
    expect(showErrorMessage).toHaveBeenCalledWith('Modbench: Failed to install "foo.7z".');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('installing "foo.7z" failed'));
    expect(await readFile(meta, 'utf8')).not.toContain('installed=true');
  });
});

describe('buildRowActionHandlers — delete', () => {
  beforeEach(() => vi.clearAllMocks());

  it('on confirm-cancel, does not trash anything', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    showWarningMessage.mockResolvedValueOnce(undefined); // user dismissed, not "Delete"

    const handlers = buildRowActionHandlers(root, vi.fn());
    handlers.delete('foo.7z');

    await vi.waitFor(() => expect(showWarningMessage).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(fsDelete).not.toHaveBeenCalled();
  });

  it('on confirm-accept, trashes the archive (and its .meta, if present)', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    showWarningMessage.mockResolvedValueOnce('Delete');

    const handlers = buildRowActionHandlers(root, vi.fn());
    handlers.delete('foo.7z');

    await vi.waitFor(() => expect(fsDelete).toHaveBeenCalledTimes(2));
    const trashedPaths = fsDelete.mock.calls.map((c) => (c[0] as { fsPath: string }).fsPath);
    expect(trashedPaths).toEqual(expect.arrayContaining([archive, meta]));
  });
});

describe('buildRowActionHandlers — hide / unhide', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hide sets removed=true on the .meta sidecar', async () => {
    const root = await makeInstanceRoot();
    const meta = await writeMeta(root, 'foo.7z');

    const handlers = buildRowActionHandlers(root, vi.fn());
    handlers.hide('foo.7z');

    await vi.waitFor(async () => {
      expect(await readFile(meta, 'utf8')).toContain('removed=true');
    });
  });

  it('unhide clears removed to false on the .meta sidecar', async () => {
    const root = await makeInstanceRoot();
    const meta = await writeMeta(root, 'foo.7z', '[General]\r\nremoved=true\r\n');

    const handlers = buildRowActionHandlers(root, vi.fn());
    handlers.unhide('foo.7z');

    await vi.waitFor(async () => {
      expect(await readFile(meta, 'utf8')).toContain('removed=false');
    });
  });
});

describe('buildRowActionHandlers — visitNexus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the Nexus mod page when the .meta has a modID', async () => {
    const root = await makeInstanceRoot();
    await writeMeta(root, 'foo.7z', '[General]\r\nmodID=123\r\n');
    await writeFile(join(root, 'ModOrganizer.ini'), '[General]\r\ngameName=Fallout4\r\n');

    const handlers = buildRowActionHandlers(root, vi.fn());
    handlers.visitNexus('foo.7z');

    await vi.waitFor(() => expect(openExternal).toHaveBeenCalled());
    const url = (openExternal.mock.calls[0][0] as { toString(): string }).toString();
    expect(url).toBe('https://www.nexusmods.com/fallout4/mods/123');
  });

  it('is a no-op when the .meta has no modID', async () => {
    const root = await makeInstanceRoot();
    await writeMeta(root, 'foo.7z');

    const handlers = buildRowActionHandlers(root, vi.fn());
    handlers.visitNexus('foo.7z');

    await new Promise((r) => setTimeout(r, 50));
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('buildRowActionHandlers — nav actions (openFile / openMeta / reveal)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('openFile OS-opens the archive', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');

    const handlers = buildRowActionHandlers(root, vi.fn());
    handlers.openFile('foo.7z');

    await vi.waitFor(() => expect(openExternal).toHaveBeenCalled());
    expect(calledFsPath(openExternal)).toBe(archive);
  });

  it('openMeta opens the .meta sidecar in the editor', async () => {
    const root = await makeInstanceRoot();
    const meta = await writeMeta(root, 'foo.7z');

    const handlers = buildRowActionHandlers(root, vi.fn());
    handlers.openMeta('foo.7z');

    await vi.waitFor(() => expect(showTextDocument).toHaveBeenCalled());
    expect(calledFsPath(showTextDocument)).toBe(meta);
  });

  it('reveal reveals the archive in the OS file manager', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');

    const handlers = buildRowActionHandlers(root, vi.fn());
    handlers.reveal('foo.7z');

    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalled());
    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', expect.objectContaining({ fsPath: archive }));
  });

  // runRowAction's catch -> log + error-notification path is shared by all four
  // nav actions (visitNexus/openFile/openMeta/reveal) — proving it once here
  // covers all of them; no need to duplicate per action.
  it('on failure, logs and surfaces an error notification naming the action and row', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    openExternal.mockRejectedValueOnce(new Error('no handler for this file type'));
    const log = vi.fn();

    const handlers = buildRowActionHandlers(root, log);
    handlers.openFile('foo.7z');

    await vi.waitFor(() => expect(showErrorMessage).toHaveBeenCalled());
    expect(showErrorMessage).toHaveBeenCalledWith('Modbench: Open File for "foo.7z" failed.');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Open File for "foo.7z" failed'));
  });
});

// ── registerDownloadsRowCommands ────────────────────────────────────────────
// Issue #214: the adapter from a native `webview/context` command invocation (its sole
// argument is the row's merged data-vscode-context, DownloadRowContext) to the
// buildRowActionHandlers handler for that action. Registration itself (that all 8 ids get
// wired to vscode.commands.registerCommand) is covered by the EXPECTED_COMMANDS integration
// test; this is the dispatch/gating behavior.
describe('registerDownloadsRowCommands', () => {
  beforeEach(() => vi.clearAllMocks());

  function invoke(commandId: string, ctx?: unknown): void {
    const call = registerCommand.mock.calls.find((c) => c[0] === commandId);
    if (!call) throw new Error(`command not registered: ${commandId}`);
    call[1](ctx);
  }

  it('registers all eight row commands', () => {
    registerDownloadsRowCommands('/instance', vi.fn());
    const ids = registerCommand.mock.calls.map((c) => c[0]);
    expect(ids).toEqual(expect.arrayContaining([
      'modbench.downloads.install',
      'modbench.downloads.visitNexus',
      'modbench.downloads.openFile',
      'modbench.downloads.openMeta',
      'modbench.downloads.reveal',
      'modbench.downloads.delete',
      'modbench.downloads.hide',
      'modbench.downloads.unhide',
    ]));
  });

  it('invoking modbench.downloads.install with a DownloadRowContext installs that row\'s archive', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    await writeMeta(root, 'foo.7z');
    executeCommand.mockResolvedValueOnce(true);

    registerDownloadsRowCommands(root, vi.fn());
    invoke('modbench.downloads.install', { webviewSection: 'downloadRow', name: 'foo.7z' });

    await vi.waitFor(() => {
      expect(executeCommand).toHaveBeenCalledWith('modbench.modList.installFromArchive', archive);
    });
  });

  it('is a no-op when invoked with no context (no row name to act on)', () => {
    registerDownloadsRowCommands('/instance', vi.fn());
    expect(() => invoke('modbench.downloads.install', undefined)).not.toThrow();
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
