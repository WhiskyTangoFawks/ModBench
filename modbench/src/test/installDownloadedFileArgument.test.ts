import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor, MarkdownString } from './vscodeMock';

const { registerCommand } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, _handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn() })),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: {},
  TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import { registerModInstallCommands } from '../mods/installCommands';
import { DownloadNode } from '../downloads/DownloadsProvider';
import { accessTo } from './mo2/adapterOver';
import { instanceValueFixture } from './mo2/instanceValueFixture';
import { recordingReporter } from './surfacingDoubles';
import { downloadRowFixture } from './mo2/downloadRowFixture';

describe('modbench.mod.install given a Downloads row', () => {
  it('hands the row of the real DownloadNode to the downloaded-file flow', async () => {
    const installDownloaded = vi.fn().mockResolvedValue(true);
    registerModInstallCommands({
      access: accessTo('/instance'), instance: { value: instanceValueFixture(), refresh: () => Promise.resolve() },
      reporterFor: () => recordingReporter(), warnIfFomod: vi.fn(),
      installDownloaded,
    });
    const row = downloadRowFixture('foo.7z');

    const handler = registerCommand.mock.calls.find((c) => c[0] === 'modbench.mod.install')?.[1];
    await handler?.(new DownloadNode(row));

    expect(installDownloaded).toHaveBeenCalledWith(row);
  });
});
