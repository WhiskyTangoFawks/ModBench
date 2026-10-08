import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor, MarkdownString } from './vscodeMock';

const { registerCommand, showInputBox, installFromArchive } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, _handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn() })),
  showInputBox: vi.fn((options: { value: string }) => Promise.resolve(options.value)),
  installFromArchive: vi.fn(),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { showInputBox, withProgress: (_options: unknown, task: () => unknown) => task() },
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
import { recordingReporter } from './surfacingDoubles';
import { downloadRowFixture } from './mo2/downloadRowFixture';

describe('the Downloads-Mods seam: modbench.mod.install given a Downloads row', () => {
  it('installs the file of the real DownloadNode', async () => {
    installFromArchive.mockResolvedValue({ applied: true, wrote: true, isFomod: false });
    registerModInstallCommands({
      access: accessTo('/instance'), instance: { value: instanceValueFixture(), refresh: () => Promise.resolve() },
      reporterFor: () => recordingReporter(), warnIfFomod: vi.fn(),
      log: vi.fn(), downloadsView: 'modbench.downloads',
    });
    const row = downloadRowFixture('foo.7z');

    const handler = registerCommand.mock.calls.find((c) => c[0] === 'modbench.mod.install')?.[1];
    await handler?.(new DownloadNode(row));

    expect(installFromArchive).toHaveBeenCalledWith(expect.anything(), expect.anything(), row.path, expect.anything());
  });
});
