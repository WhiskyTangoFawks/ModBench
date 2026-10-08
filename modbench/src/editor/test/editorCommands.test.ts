import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commandHandlers, executeCommand, executed, forgetRegistrations, pickRecord, recordGridVscode, register, reporter } from './recordGridHarness';

vi.mock('../recordPicker', () => ({ pickRecord: (...args: unknown[]) => pickRecord(...args) }));
vi.mock('vscode', () => recordGridVscode);

import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

beforeEach(forgetRegistrations);

describe('modbench.record.open from the palette, with no Argument', () => {
  const open = () => commandHandlers.get('modbench.record.open')?.();
  const winner = { name: 'A.esp', origin: 'ModA' };
  const rowOf = (formKey: string) => ({ argument: { kind: 'record', plugin: winner, formKey } });
  const renderingTheWinner = (): { meditClient: InMemoryMEditClient } => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordOwner', winner);
    meditClient.setQueryAnswer('getCopyDocument', { path: null, isContainersDocument: false, renderedFileName: 'Gun.json' });
    return { meditClient };
  };

  it('opens the records selected in the focused view as one grid, a preview, on the first record\'s document', async () => {
    await register({ selection: () => [rowOf('000801:A.esp'), rowOf('000802:A.esp')], ...renderingTheWinner() });

    await open();

    expect(executed().filter(([id]) => id === 'vscode.openWith')).toEqual([[
      'vscode.openWith', '/ModA/A.esp/Gun.json?formKey=000801%3AA.esp&name=A.esp&origin=ModA', 'modbench.record',
      { viewColumn: -1, preview: true },
    ]]);
  });

  it('asks for a record when the focused view has none selected, and opens the one picked as a preview', async () => {
    pickRecord.mockResolvedValue('000801:A.esp');
    await register({ selection: () => [{ kind: 'recordType' }], ...renderingTheWinner() });

    await open();

    expect(pickRecord.mock.calls).toEqual([[{ meditClient: expect.any(InMemoryMEditClient) as unknown, reporter }, '', []]]);
    expect(executeCommand).toHaveBeenCalledWith(
      'vscode.openWith', '/ModA/A.esp/Gun.json?formKey=000801%3AA.esp&name=A.esp&origin=ModA', 'modbench.record',
      { viewColumn: -1, preview: true });
  });

  it('opens nothing when the picker is dismissed', async () => {
    pickRecord.mockResolvedValue(null);
    await register();

    await open();

    expect(executed()).toEqual([]);
  });

  it('refuses, saying why, when it is given something that names no record', async () => {
    reporter.report.mockClear();
    await register();

    await commandHandlers.get('modbench.record.open')?.({ kind: 'recordType' });

    expect(reporter.report).toHaveBeenCalledWith('error', 'Could not open a record.', 'What was given names no record.');
    expect(pickRecord).not.toHaveBeenCalled();
    expect(executed()).toEqual([]);
  });

  it('reports a record VS Code could not open', async () => {
    reporter.report.mockClear();
    await register({ selection: () => [rowOf('000801:A.esp')], ...renderingTheWinner() });
    executeCommand.mockRejectedValueOnce(new Error('no editor'));

    await open();

    expect(reporter.report.mock.calls).toEqual([['error', 'Failed to open "000801:A.esp".', 'no editor']]);
  });

  it('does not ask when the selection holds a record', async () => {
    await register({ selection: () => [rowOf('000801:A.esp')] });

    await open();

    expect(pickRecord).not.toHaveBeenCalled();
  });
});

describe('modbench.record.open on a copy, a record and the plugin it is in', () => {
  const GUN = '000801:A.esp';
  const plugin = { name: 'A.esp', origin: 'ModA' };
  const FILE = '/mods/ModA/plugin-source/A.esp/Weapons/Gun.json';
  const opened = () => executed().filter(([id]) => id === 'vscode.openWith').map(([, uri, viewType]) => [uri, viewType]);

  const inFile = (path: string, isContainersDocument = false) => ({ path, isContainersDocument });
  const rendered = (renderedFileName: string) => ({ path: null, isContainersDocument: false, renderedFileName });

  async function registerAnswering(document: ReturnType<typeof inFile> | ReturnType<typeof rendered> | null): Promise<void> {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getCopyDocument', document);
    await register({ meditClient });
  }

  it('opens a tracked copy\'s file in the record grid, as a preview', async () => {
    await registerAnswering(inFile(FILE));

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: GUN, plugin } });

    expect(executed().map(([id, uri, ...rest]) => [id, String(uri), ...rest])).toEqual([
      ['vscode.openWith', `file://${FILE}`, 'modbench.record', { viewColumn: -1, preview: true }],
    ]);
  });

  it('opens an untracked copy, which has no file, as the document mEdit renders it as, in the record grid', async () => {
    await registerAnswering(rendered('Gun.json'));

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: GUN, plugin } });

    expect(opened()).toEqual([['/ModA/A.esp/Gun.json?formKey=000801%3AA.esp&name=A.esp&origin=ModA', 'modbench.record']]);
  });

  it('opens an untracked plugin\'s header as the document mEdit renders it as', async () => {
    await registerAnswering(rendered('A.esp.json'));

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: '000000:A.esp', plugin } });

    expect(opened()).toEqual([['/ModA/A.esp/A.esp.json?formKey=000000%3AA.esp&name=A.esp&origin=ModA', 'modbench.record']]);
  });

  it('opens an untracked placed reference as its own rendered document, named by its own EditorID', async () => {
    const PLACED = '000803:A.esp';
    await registerAnswering(rendered('SharedRef - 000803_A.esp.json'));

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', plugin, formKey: PLACED } });

    expect(opened()).toEqual([['/ModA/A.esp/SharedRef - 000803_A.esp.json?formKey=000803%3AA.esp&name=A.esp&origin=ModA', 'modbench.record']]);
  });

  it('opens a copy carried in another record\'s file, as a placed reference is in its cell\'s, in a tab of its own on that file', async () => {
    await registerAnswering(inFile(FILE, true));

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: GUN, plugin } });

    expect(opened()).toEqual([[`modbench-child-record:${FILE}?formKey=000801%3AA.esp&name=A.esp&origin=ModA`, 'modbench.record']]);
  });

  it('opens the winning copy\'s document for a record given without a plugin', async () => {
    const meditClient = new InMemoryMEditClient();
    const winner = { name: 'B.esp', origin: 'ModB' };
    meditClient.setQueryAnswer('getRecordOwner', winner);
    meditClient.setQueryAnswer('getCopyDocument', { path: null, isContainersDocument: false, renderedFileName: 'Gun.json' });
    await register({ meditClient });

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: GUN } });

    expect(opened()).toEqual([['/ModB/B.esp/Gun.json?formKey=000801%3AA.esp&name=B.esp&origin=ModB', 'modbench.record']]);
  });

  it('refuses a record given without a plugin that no active plugin holds, naming it, and opens nothing', async () => {
    reporter.report.mockClear();
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordOwner', undefined);
    await register({ meditClient });

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: GUN } });

    expect(reporter.report.mock.calls).toEqual([['error', `Failed to open "${GUN}".`, `No active plugin holds ${GUN}.`]]);
    expect(opened()).toEqual([]);
  });

  it('refuses several records when no active plugin holds one given without a plugin, naming it, and opens nothing', async () => {
    reporter.report.mockClear();
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordOwner', undefined);
    meditClient.setQueryAnswer('getCopyDocument', { path: null, isContainersDocument: false, renderedFileName: 'Gun.json' });
    await register({ meditClient });

    await commandHandlers.get('modbench.record.open')?.([{ argument: { kind: 'record', formKey: GUN, plugin } }, { argument: { kind: 'record', formKey: '000802:A.esp' } }]);

    expect(reporter.report.mock.calls).toEqual([['error', `Failed to open "${GUN}".`, 'No active plugin holds 000802:A.esp.']]);
    expect(opened()).toEqual([]);
  });

  it('refuses a copy the plugin does not hold, naming it, and opens nothing', async () => {
    reporter.report.mockClear();
    await registerAnswering(null);

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: GUN, plugin } });

    expect(reporter.report.mock.calls).toEqual([['error', `Failed to open "${GUN}".`, `A.esp (ModA) holds no ${GUN}.`]]);
    expect(opened()).toEqual([]);
  });
});

describe('modbench.record.openToSide, the menus\' entry point', () => {
  it('fires open with the menu selection, each record placed beside', async () => {
    await register();
    const [a, b] = [{ argument: { kind: 'record', formKey: '000801:A.esp' } }, { argument: { kind: 'record', formKey: '000802:A.esp' } }];

    await commandHandlers.get('modbench.record.openToSide')?.(a, [a, b]);

    expect(executeCommand).toHaveBeenCalledWith('modbench.record.open', [
      { ...a, placement: 'beside' }, { ...b, placement: 'beside' },
    ]);
  });
});
