import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { instanceHolding, rowsOf, symbolsOver } from './symbolsOver';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const BASE = { name: 'Base.esm', origin: 'Base Mod' };
const FOLDER = { kind: 'loose', path: '/mods/Base Mod' } as const;
const COPY = { kind: 'loose', path: '/mods/Base Mod/meshes/a.nif' } as const;
const mod = { argument: { kind: 'mod', name: 'Base Mod' } };
const separator = { kind: 'separator', separator: { kind: 'separator', name: 'Gear', enabled: true } };
const downloadedFile = { argument: { kind: 'downloadedFile', row: downloadedFileRowFixture('Patch-1.7z') } };
const pluginRow = { argument: { kind: 'plugin', plugin: BASE } };
const fileRow = { a: 'file row' };
const recordRow = { argument: { kind: 'record', formKey: '000801:Base.esm' } };

function setup(selection: readonly unknown[] = [], { shown = true } = {}) {
  const presented: unknown[] = [];
  const shows = (row: string) => () => { presented.push(row); return Promise.resolve(); };
  const made = symbolsOver({
    instance: instanceHolding(instanceValueFixture({
      mods: [{ kind: 'mod', name: 'Base Mod', enabled: true }, { kind: 'separator', name: 'Gear', enabled: true }],
      downloadedFiles: { kind: 'listed', rows: [downloadedFileRowFixture('Patch-1.7z')] },
      plugins: [{ ...BASE, path: '/data/Base.esm', line: 0, enabled: true, winning: true }],
    })),
    rows: rowsOf({
      selection: () => selection,
      mods: { show: ({ kind, name }) => (shown ? shows(`${kind} ${name}`) : undefined), folderOf: () => FOLDER.path, dataPathOf: (row) => (row === fileRow ? 'meshes/a.nif' : undefined) },
      plugins: { show: ({ name }) => shows(`plugin ${name}`) },
    }),
    downloadedFileRow: (name) => shows(`downloaded file ${name}`),
    fileCopies: { copyOf: (path) => (path === 'meshes/a.nif' ? COPY : { none: `Nothing holds ${path}.` }), reveal: (copy) => { presented.push(copy); return Promise.resolve(); } },
  });
  return { ...made, presented, run: (row?: unknown) => host.run('modbench.symbol.goTo', row) };
}

describe('go to presents the definition of the symbol a row stands for (commands.md, `go to` under Symbol)', () => {
  it.each<[string, unknown, unknown]>([
    ['a mod row', mod, 'mod Base Mod'],
    ['a separator row', separator, 'separator Gear'],
    ['a downloaded file row', downloadedFile, 'downloaded file Patch-1.7z'],
    ['a plugin row', pluginRow, 'plugin Base.esm'],
    ['a file row', fileRow, COPY],
  ])('asks for the symbol of %s', async (_what, row, definition) => {
    const { presented, run } = setup();

    await run(row);

    expect(presented).toEqual([definition]);
  });

  it('selects the row its definition names', async () => {
    const { presented, run } = setup();

    await run(separator);

    expect([presented, host.executed.filter(([id]) => id !== 'setContext')]).toEqual([['separator Gear'], []]);
  });

  it('shows the copy its definition names in the Explorer', async () => {
    const { presented, run } = setup([], { shown: false });

    await run(mod);

    expect(presented).toEqual([FOLDER]);
  });

  it('says why when the symbol is refused', async () => {
    const { reporter, run } = setup([], { shown: false });

    await run(separator);

    expect(reporter.reports.map(({ severity, message }) => [severity, message])).toEqual([['error', 'Could not go to "Gear": Mods shows no row for it.']]);
  });

  it('refuses a record, which open shows, and asks for nothing', async () => {
    const { presented, reporter, run } = setup([mod]);

    await run(recordRow);

    expect([presented, reporter.reports.map(({ severity }) => severity), host.executed.filter(([id]) => id !== 'setContext')]).toEqual([[], ['error'], []]);
  });
});

describe('go to with no row clicked (commands.md, The entry point supplies what it knows)', () => {
  it.each<[string, unknown, unknown]>([
    ['a separator', separator, 'separator Gear'],
    ['a file', fileRow, COPY],
  ])('takes the one selected row, %s', async (_what, row, definition) => {
    const { presented, run } = setup([row]);

    await run();

    expect(presented).toEqual([definition]);
  });

  it.each<[string, readonly unknown[]]>([
    ['nothing selected', []],
    ['several rows selected', [mod, separator]],
    ['a row that stands for no symbol', [{ a: 'row' }]],
  ])('asks as Go to Symbol in Workspace finds a symbol, with %s', async (_what, selection) => {
    const { presented, run } = setup(selection);

    await run();

    expect([presented, host.executed.filter(([id]) => id !== 'setContext')]).toEqual([[], [['workbench.action.showAllSymbols']]]);
  });
});
