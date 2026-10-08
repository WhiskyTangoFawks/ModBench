import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor, MarkdownString } from './vscodeMock';

const { registerCommand, createQuickPick, installFromArchive } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, _handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn() })),
  createQuickPick: vi.fn(),
  installFromArchive: vi.fn(),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { createQuickPick, withProgress: (_options: unknown, task: () => unknown) => task() },
  TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

vi.mock('../install/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../install/install')>()),
  installFromArchive,
}));

import { registerModInstallCommands } from '../mods/installCommands';
import { DownloadNode } from '../downloads/DownloadsProvider';
import { accessTo } from './mo2/adapterOver';
import { instanceValueFixture } from './mo2/instanceValueFixture';
import { fakeQuickPick } from '../drivingLib/test/quickPickDouble';
import { recordingReporter } from './surfacingDoubles';
import { downloadRowFixture } from './mo2/downloadRowFixture';

describe('the Downloads-Mods seam: modbench.mod.install given a Downloads row', () => {
  it('offers the upgrades the real DownloadNode carries', async () => {
    const { qp, escape } = fakeQuickPick<{ label: string }>();
    createQuickPick.mockReturnValue(qp);
    registerModInstallCommands({
      access: accessTo('/instance'), instance: { value: instanceValueFixture(), refresh: () => Promise.resolve() },
      reporterFor: () => recordingReporter(), warnIfFomod: vi.fn(),
      downloadInstall: { reporter: recordingReporter(), log: vi.fn(), progressViewId: 'modbench.downloads' },
    });
    const node = new DownloadNode(downloadRowFixture('foo.7z'), [{ modName: 'Harder VATS', version: '1.0', tier: 'fileId' }]);

    const handler = registerCommand.mock.calls.find((c) => c[0] === 'modbench.mod.install')?.[1];
    const running = handler?.(node);
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();
    await running;

    expect(qp.items.map((item) => item.label)).toEqual(['Harder VATS (v1.0)', 'Install as a new mod…']);
  });
});
