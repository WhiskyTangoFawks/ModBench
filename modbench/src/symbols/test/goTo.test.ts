import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

const { handlers, executeCommand } = vi.hoisted(() => ({
  handlers: new Map<string, (clicked?: unknown) => Promise<void>>(),
  executeCommand: vi.fn((_command: string, ..._args: unknown[]) => Promise.resolve()),
}));

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, Uri,
  commands: {
    registerCommand: (command: string, handler: (clicked?: unknown) => Promise<void>) => { handlers.set(command, handler); return { dispose: vi.fn() }; },
    executeCommand,
  },
  Position: class { constructor(readonly line: number, readonly character: number) {} },
  Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
}));

import { registerGoTo } from '../goTo';
import { present } from '../../ports/present';
import { recordingReporter } from '../../test/surfacingDoubles';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';
import type { CopyAt } from '../../instanceLoader/fileConflictIndex';
import type { Definition } from '../symbolKind';
import { fakeKind, fakeKinds } from './fakeKinds';

const BASE = { name: 'Base.esm', origin: 'Base Mod' };
const FOLDER = { kind: 'loose', path: '/mods/Base Mod' } as const;
const mod = { argument: { kind: 'mod', name: 'Base Mod' } };
const separator = { kind: 'separator', separator: { kind: 'separator', name: 'Gear', enabled: true } };
const downloadedFile = { argument: { kind: 'downloadedFile', row: downloadedFileRowFixture('Patch-1.7z') } };
const pluginRow = { argument: { kind: 'plugin', plugin: BASE } };
const fileRow = { a: 'file row' };
const recordRow = { argument: { kind: 'record', formKey: '000801:Base.esm' } };
const SHOWS_ROW: Definition = { row: 'Mods', show: () => Promise.resolve() };

beforeEach(() => { handlers.clear(); executeCommand.mockClear(); });

function setup(definition: Definition, selection: readonly unknown[] = []) {
  const show = vi.fn(() => Promise.resolve());
  const reveal = vi.fn((_copy: CopyAt) => Promise.resolve());
  const asked = vi.fn((_symbol: never) => Promise.resolve('row' in definition ? { ...definition, show } : definition));
  const answering = { definitionOf: asked };
  const kinds = fakeKinds({ entry: fakeKind(answering), plugin: fakeKind(answering), file: fakeKind(answering) });
  const reporter = recordingReporter();
  registerGoTo({ kinds, reveal, reporter, selection: () => selection, dataPathOf: (row) => (row === fileRow ? 'meshes/a.nif' : undefined) });
  return { show, reveal, asked, reporter, run: present(handlers.get('modbench.symbol.goTo'), 'the go to command') };
}

describe('go to presents the definition of the symbol a row stands for (commands.md, `go to` under Symbol)', () => {
  it.each<[string, unknown, unknown]>([
    ['a mod row', mod, { kind: 'mod', name: 'Base Mod' }],
    ['a separator row', separator, { kind: 'separator', name: 'Gear' }],
    ['a downloaded file row', downloadedFile, { kind: 'downloadedFile', name: 'Patch-1.7z' }],
    ['a plugin row', pluginRow, { kind: 'plugin', ...BASE }],
    ['a file row', fileRow, { kind: 'file', path: 'meshes/a.nif' }],
  ])('asks for the symbol of %s', async (_what, row, symbol) => {
    const { asked, run } = setup(SHOWS_ROW);

    await run(row);

    expect(asked.mock.calls).toEqual([[symbol, undefined]]);
  });

  it('selects the row its definition names', async () => {
    const { show, run } = setup(SHOWS_ROW);

    await run(separator);

    expect([show.mock.calls.length, executeCommand.mock.calls]).toEqual([1, []]);
  });

  it('shows the copy its definition names in the Explorer', async () => {
    const { reveal, run } = setup({ shown: FOLDER });

    await run(mod);

    expect(reveal.mock.calls).toEqual([[FOLDER]]);
  });

  it('opens the file its definition names', async () => {
    const { run } = setup({ file: '/scripts/Quest.psc' });

    await run(mod);

    expect(executeCommand.mock.calls.map(([command, uri]) => [command, uri])).toEqual([['vscode.open', Uri.file('/scripts/Quest.psc')]]);
  });

  it.each<[string, Definition, string]>([
    ['has none', { none: 'A profile has no definition.' }, 'Could not go to "Base Mod": A profile has no definition.'],
    ['is refused', { refused: 'Mods shows no row for it.' }, 'Could not go to "Base Mod": Mods shows no row for it.'],
  ])('says why when the symbol %s', async (_case, definition, message) => {
    const { reporter, run } = setup(definition);

    await run(mod);

    expect(reporter.reports.map(({ severity, message: said }) => [severity, said])).toEqual([['error', message]]);
  });

  it('refuses a record, which open shows, and asks for nothing', async () => {
    const { asked, reporter, run } = setup(SHOWS_ROW, [mod]);

    await run(recordRow);

    expect([asked.mock.calls, reporter.reports.map(({ severity }) => severity), executeCommand.mock.calls]).toEqual([[], ['error'], []]);
  });
});

describe('go to with no row clicked (commands.md, The entry point supplies what it knows)', () => {
  it.each<[string, unknown, unknown]>([
    ['a separator', separator, { kind: 'separator', name: 'Gear' }],
    ['a file', fileRow, { kind: 'file', path: 'meshes/a.nif' }],
  ])('takes the one selected row, %s', async (_what, row, symbol) => {
    const { asked, run } = setup(SHOWS_ROW, [row]);

    await run();

    expect(asked.mock.calls).toEqual([[symbol, undefined]]);
  });

  it.each<[string, readonly unknown[]]>([
    ['nothing selected', []],
    ['several rows selected', [mod, separator]],
    ['a row that stands for no symbol', [{ a: 'row' }]],
  ])('asks as Go to Symbol in Workspace finds a symbol, with %s', async (_what, selection) => {
    const { asked, run } = setup(SHOWS_ROW, selection);

    await run();

    expect([asked.mock.calls, executeCommand.mock.calls]).toEqual([[], [['workbench.action.showAllSymbols']]]);
  });
});
