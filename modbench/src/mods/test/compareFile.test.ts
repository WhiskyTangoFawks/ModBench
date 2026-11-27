import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import type * as vscode from 'vscode';
import { modsViewOn } from './modsViewOn';
import { readFile, seen } from './modsVscode';
import { modOrigin } from '../../instanceLoader/fileConflictIndex';
import { FakeUri } from '../../test/vscodeMock';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { present } from '../../ports/present';
import { file, folder, indexedValueOf, mod } from './indexedValue';
import { registerArchiveFiles } from '../archiveFiles';

const PATH = 'textures/a.dds';

const ARCHIVE = '/instance/Alone/Alone.ba2';

async function setup(overwrite = false) {
  const value = await indexedValueOf([mod('High'), mod('Middle'), mod('Low'), mod('Alone')], {
    High: { files: [file('High', PATH)] },
    Middle: { files: [file('Middle', PATH)], folders: [folder('Middle', 'textures')] },
    Low: { files: [file('Low', PATH), file('Low', 'b.dds')] },
    Alone: { files: [file('Alone', 'c.dds'), file('Alone', 'Alone.ba2')] },
  }, overwrite ? { files: [file('overwrite', PATH)] } : undefined, [{ origin: modOrigin('Alone'), archive: ARCHIVE, files: [PATH] }]);
  const shown = modsViewOn({ value });
  const invoke = (...args: unknown[]) => shown.run('modbench.mod.compareFile', ...args);
  const cell = (modName: string, path = PATH) => ({ webviewSection: 'conflictCell', origin: { kind: 'mod', name: modName }, path, preventDefaultContextMenuItems: true });
  const fileRow = async (modName: string): Promise<vscode.TreeItem> => shown.row('a.dds', await shown.row('textures', await shown.row(modName)));
  const pathOf = (uri: unknown) => { const { scheme, fsPath } = expectInstanceOf(uri, FakeUri); return `${scheme}:${fsPath}`; };
  const diffs = () => seen.executed.filter(([id]) => id === 'vscode.diff').map(([, left, right, title]) => [pathOf(left), pathOf(right), title]);
  return { ...shown, invoke, cell, fileRow, diffs };
}

type Harness = Awaited<ReturnType<typeof setup>>;

describe('the compare file command', () => {
  it.each<[string, boolean, (h: Harness) => unknown, [string, string, string]]>([
    ['a cell\'s copy and the winning copy, titled with the file and both mods', false, (h) => h.cell('Low'),
      ['file:/instance/Low/textures/a.dds', 'file:/instance/High/textures/a.dds', 'textures/a.dds: Low ↔ High']],
    ['a cell\'s copy and Overwrite\'s when Overwrite wins', true, (h) => h.cell('Middle'),
      ['file:/instance/Middle/textures/a.dds', 'file:/instance/overwrite/textures/a.dds', 'textures/a.dds: Middle ↔ Overwrite']],
    ['the Mods file row\'s copy as it takes a cell\'s', false, (h) => h.fileRow('Middle'),
      ['file:/instance/Middle/textures/a.dds', 'file:/instance/High/textures/a.dds', 'textures/a.dds: Middle ↔ High']],
    ['an archived copy, read from its archive', false, (h) => h.cell('Alone'),
      ['modbench-archive:/Alone.ba2/textures/a.dds', 'file:/instance/High/textures/a.dds', 'textures/a.dds: Alone ↔ High']],
  ])('opens the diff editor on %s', async (_case, overwrite, argument, diff) => {
    const h = await setup(overwrite);

    await h.invoke(await argument(h));

    expect(h.diffs()).toEqual([diff]);
  });

  it('opens an archived copy at a URI the archive file system reads from the archive', async () => {
    const { invoke, cell, client } = await setup();
    await invoke(cell('Alone'));
    const archived = present(seen.executed.find(([id]) => id === 'vscode.diff'), 'the diff')[1];
    client.setQueryAnswer('getArchiveFile', new Uint8Array([1]));
    registerArchiveFiles(client);

    await readFile(expectInstanceOf(archived, FakeUri));

    expect(client.calls.filter((call) => call.method === 'getArchiveFile').map((call) => call.args)).toEqual([['Fallout4', ARCHIVE, PATH]]);
  });

  it.each([
    ['the winning copy', 'High', PATH, '"High" holds the winning copy.'],
    ['a mod with no copy of the file', 'Alone', 'b.dds', '"Alone" has no copy of it.'],
    ['a file no other copy shares', 'Low', 'b.dds', '"Low" holds the winning copy.'],
  ])('refuses %s, saying so', async (_case, modName, path, detail) => {
    const { invoke, cell, diffs, reporter } = await setup();

    await invoke(cell(modName, path));

    expect(diffs()).toEqual([]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: `Failed to compare "${path}".`, detail }]);
  });

  it('opens nothing with no cell or file row to take', async () => {
    const { invoke, diffs, reporter } = await setup();

    await invoke();
    await invoke({ webviewSection: 'conflictColumn', mod: 'Low' });

    expect(diffs()).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it('reports a diff VS Code could not open', async () => {
    const { invoke, cell, reporter } = await setup();
    seen.commands.set('vscode.diff', () => Promise.reject(new Error('no editor')));

    await invoke(cell('Low'));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to compare "textures/a.dds".', detail: 'no editor' }]);
  });
});
