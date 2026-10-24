import { unreadStatus } from './unreadStatus';
import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor, MarkdownString } from './vscodeMock';

const { registerCommand, createQuickPick } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, _handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn() })),
  createQuickPick: vi.fn(),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { createQuickPick, withProgress: (_options: unknown, task: () => unknown) => task() },
  TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import { registerModInstallCommands } from '../mods/installCommands';
import { DownloadedFileNode } from '../downloads/DownloadsProvider';
import { modCommands } from '../modCommands/modCommands';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter } from './fakeInstanceAdapter';
import { instanceValueFixture } from './mo2/instanceValueFixture';
import { fakeQuickPick } from '../drivingLib/test/quickPickDouble';
import { recordingReporter } from './surfacingDoubles';
import { downloadedFileRowFixture } from './mo2/downloadedFileRowFixture';

describe('the Downloads-Mods seam: modbench.mod.install given a Downloads row', () => {
  it('offers the upgrades the Instance value lists for the file of a real DownloadedFileNode', async () => {
    const row = downloadedFileRowFixture('foo.7z', { upgrades: [{ modName: 'Harder VATS', version: '1.0', tier: 'fileId' }] });
    const instance = { value: instanceValueFixture({ downloadedFiles: { kind: 'listed', rows: [row] } }), refresh: () => Promise.resolve() };
    const { qp, escape } = fakeQuickPick<{ label: string }>();
    createQuickPick.mockReturnValue(qp);
    registerModInstallCommands({
      commands: modCommands(fakeInstanceAdapter().adapter, new InMemoryMEditClient(), unreadStatus), instance,
      reporterFor: () => recordingReporter(), ask: vi.fn(),
      downloadedFileInstallReporting: { reporter: recordingReporter(), log: vi.fn(), progressViewId: 'modbench.downloads' },
    });
    const node = new DownloadedFileNode(downloadedFileRowFixture('foo.7z'));

    const handler = registerCommand.mock.calls.find((c) => c[0] === 'modbench.mod.install')?.[1];
    const running = handler?.(node);
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();
    await running;

    expect(qp.items.map((item) => item.label)).toEqual(['Harder VATS (v1.0)', 'Install as a new mod…']);
  });
});
