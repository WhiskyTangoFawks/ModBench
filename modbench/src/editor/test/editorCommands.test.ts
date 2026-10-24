import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commandHandlers, editorVscode, executeCommand, executed } from './editorVscode';
import { forgetEditor, pickRecord, register, reporter } from './editorHarness';

vi.mock('../recordPicker', () => ({ pickRecord: (...args: unknown[]) => pickRecord(...args) }));
vi.mock('vscode', () => editorVscode);

import { AgentCall } from '../../drivingLib/agentGesture';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

beforeEach(forgetEditor);

describe('modbench.record.open from the palette, with no Argument', () => {
  const open = () => commandHandlers.get('modbench.record.open')?.();
  const winner = { name: 'A.esp', origin: 'ModA' };
  const rowOf = (formKey: string) => ({ argument: { kind: 'record', plugin: winner, formKey } });
  const renderingTheWinner = (): { meditClient: InMemoryMEditClient } => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordOwner', winner);
    meditClient.setQueryAnswer('getCopyDocument', { kind: 'Rendered', location: 'Gun.json' });
    return { meditClient };
  };

  it('opens the records selected in the focused view as one grid, a preview, on the first record\'s document', async () => {
    register({ selection: () => [rowOf('000801:A.esp'), rowOf('000802:A.esp')], ...renderingTheWinner() });

    await open();

    expect(executed().filter(([id]) => id === 'vscode.openWith').map(([id, uri, ...rest]) => [id, String(uri), ...rest])).toEqual([[
      'vscode.openWith', 'modbench-rendered:/ModA/A.esp/Gun.json?formKey=000801%3AA.esp&name=A.esp&origin=ModA', 'modbench.record',
      { viewColumn: -1, preview: true },
    ]]);
    expect(pickRecord).not.toHaveBeenCalled();
  });

  it('asks for a record when the focused view has none selected, and opens the one picked as a preview', async () => {
    pickRecord.mockResolvedValue('000801:A.esp');
    register({ selection: () => [{ kind: 'recordType' }], ...renderingTheWinner() });

    await open();

    expect(executeCommand.mock.calls.map(([id, uri, ...rest]) => [id, String(uri), ...rest])).toContainEqual([
      'vscode.openWith', 'modbench-rendered:/ModA/A.esp/Gun.json?formKey=000801%3AA.esp&name=A.esp&origin=ModA', 'modbench.record',
      { viewColumn: -1, preview: true },
    ]);
  });

  it('opens nothing when the picker is dismissed', async () => {
    pickRecord.mockResolvedValue(null);
    register();

    await open();

    expect(executed()).toEqual([]);
  });

  it('refuses, saying why, when it is given something that names no record', async () => {
    register();

    await commandHandlers.get('modbench.record.open')?.({ kind: 'recordType' });

    expect(reporter.report).toHaveBeenCalledWith('error', 'Could not open a record.', 'What was given names no record.');
    expect(pickRecord).not.toHaveBeenCalled();
    expect(executed()).toEqual([]);
  });

  it('reports a record VS Code could not open', async () => {
    register({ selection: () => [rowOf('000801:A.esp')], ...renderingTheWinner() });
    executeCommand.mockRejectedValueOnce(new Error('no editor'));

    await open();

    expect(reporter.report.mock.calls).toEqual([['error', 'Failed to open "000801:A.esp".', 'no editor']]);
  });

});

describe('modbench.record.open on a copy, a record and the plugin it is in', () => {
  const GUN = '000801:A.esp';
  const plugin = { name: 'A.esp', origin: 'ModA' };
  const FILE = '/source/ModA/plugin-source/A.esp/Weapons/Gun.json';
  const opened = () => executed().filter(([id]) => id === 'vscode.openWith').map(([, uri, viewType]) => [String(uri), viewType]);

  const inFile = (location: string, isContainersDocument = false) => ({ kind: isContainersDocument ? 'ContainersFile' as const : 'OwnFile' as const, location });
  const rendered = (location: string) => ({ kind: 'Rendered' as const, location });

  function registerAnswering(document: ReturnType<typeof inFile> | ReturnType<typeof rendered> | null): void {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getCopyDocument', document);
    register({ meditClient });
  }

  it('opens a compiled plugin copy\'s file in the record grid, as a preview', async () => {
    registerAnswering(inFile(FILE));

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: GUN, plugin } });

    expect(executed().map(([id, uri, ...rest]) => [id, String(uri), ...rest])).toEqual([
      ['vscode.openWith', `file://${FILE}`, 'modbench.record', { viewColumn: -1, preview: true }],
    ]);
  });

  it('opens a record given as pinned in the active group, not as a preview', async () => {
    registerAnswering(rendered('Gun.json'));

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: GUN, plugin }, pinned: true });

    expect(executed().filter(([id]) => id === 'vscode.openWith').map(([, , , options]) => options))
      .toEqual([{ viewColumn: -1, preview: false }]);
  });

  it.each([
    ['a non-compiled plugin copy, which has no file, as the document mEdit renders it as', rendered('Gun.json'), GUN,
      'modbench-rendered:/ModA/A.esp/Gun.json?formKey=000801%3AA.esp&name=A.esp&origin=ModA'],
    ['a non-compiled plugin\'s header as the document mEdit renders it as', rendered('A.esp.json'), '000000:A.esp',
      'modbench-rendered:/ModA/A.esp/A.esp.json?formKey=000000%3AA.esp&name=A.esp&origin=ModA'],
    ['a non-compiled plugin placed reference as its own rendered document, named by its own EditorID', rendered('SharedRef - 000803_A.esp.json'), '000803:A.esp',
      'modbench-rendered:/ModA/A.esp/SharedRef - 000803_A.esp.json?formKey=000803%3AA.esp&name=A.esp&origin=ModA'],
    ['a copy carried in another record\'s file, as a placed reference is in its cell\'s, in a tab of its own on that file', inFile(FILE, true), GUN,
      `modbench-child-record:${FILE}?formKey=000801%3AA.esp&name=A.esp&origin=ModA`],
  ])('opens %s, in the record grid', async (_, document, formKey, uri) => {
    registerAnswering(document);

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey, plugin } });

    expect(opened()).toEqual([[uri, 'modbench.record']]);
  });

  it('opens the winning copy\'s document for a record given without a plugin', async () => {
    const meditClient = new InMemoryMEditClient();
    const winner = { name: 'B.esp', origin: 'ModB' };
    meditClient.setQueryAnswer('getRecordOwner', winner);
    meditClient.setQueryAnswer('getCopyDocument', { kind: 'Rendered', location: 'Gun.json' });
    register({ meditClient });

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: GUN } });

    expect(opened()).toEqual([['modbench-rendered:/ModB/B.esp/Gun.json?formKey=000801%3AA.esp&name=B.esp&origin=ModB', 'modbench.record']]);
  });

  it('refuses a record given without a plugin that no active plugin holds, naming it, and opens nothing', async () => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordOwner', undefined);
    register({ meditClient });

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: GUN } });

    expect(reporter.report.mock.calls).toEqual([['error', `Failed to open "${GUN}".`, `No active plugin holds ${GUN}.`]]);
    expect(opened()).toEqual([]);
  });

  it('refuses several records when no active plugin holds one given without a plugin, naming it, and opens nothing', async () => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordOwner', undefined);
    meditClient.setQueryAnswer('getCopyDocument', { kind: 'Rendered', location: 'Gun.json' });
    register({ meditClient });

    await commandHandlers.get('modbench.record.open')?.([{ argument: { kind: 'record', formKey: GUN, plugin } }, { argument: { kind: 'record', formKey: '000802:A.esp' } }]);

    expect(reporter.report.mock.calls).toEqual([['error', `Failed to open "${GUN}".`, 'No active plugin holds 000802:A.esp.']]);
    expect(opened()).toEqual([]);
  });

  it('refuses a copy the plugin does not hold, naming it, and opens nothing', async () => {
    registerAnswering(null);

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: GUN, plugin } });

    expect(reporter.report.mock.calls).toEqual([['error', `Failed to open "${GUN}".`, `A.esp (ModA) holds no ${GUN}.`]]);
    expect(opened()).toEqual([]);
  });
});

describe('modbench.record.openPinned, the menus\' entry point', () => {
  it('fires open with the menu selection, each record pinned', async () => {
    register();
    const [a, b] = [{ argument: { kind: 'record', formKey: '000801:A.esp' } }, { argument: { kind: 'record', formKey: '000802:A.esp' } }];

    await commandHandlers.get('modbench.record.openPinned')?.(a, [a, b]);

    expect(executeCommand).toHaveBeenCalledWith('modbench.record.open', [
      { ...a, pinned: true }, { ...b, pinned: true },
    ]);
  });
});

describe('modbench.record.open on records two of which cannot open', () => {
  it('reports the first record\'s failure, not a later column\'s', async () => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getCopyDocument', null);
    meditClient.setQueryAnswer('getRecordOwner', undefined);
    register({ meditClient });

    await commandHandlers.get('modbench.record.open')?.([
      { argument: { kind: 'record', formKey: '000801:A.esp', plugin: { name: 'A.esp', origin: 'ModA' } } },
      { argument: { kind: 'record', formKey: '000802:A.esp' } },
    ]);

    expect(reporter.report.mock.calls).toEqual([['error', 'Failed to open "000801:A.esp".', expect.stringContaining('000801:A.esp')]]);
  });
});

describe('modbench.record.open for the agent', () => {
  const plugin = { name: 'A.esp', origin: 'ModA' };
  const call = (formKeys: string[], options: object = {}) =>
    commandHandlers.get('modbench.record.open')?.(new AgentCall(formKeys.map((formKey) => ({ kind: 'record' as const, formKey, plugin })), options));
  const openingAs = (answer: { kind: 'Rendered'; location: string } | null) => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getCopyDocument', answer);
    return meditClient;
  };

  it('opens the given records and answers the copies that landed, never asking the selection or a picker', async () => {
    register({ meditClient: openingAs({ kind: 'Rendered', location: 'Gun.json' }), selection: () => [{ argument: { kind: 'record', formKey: '0009:A.esp', plugin } }] });

    const answer = await call(['000801:A.esp', '000802:A.esp'], { pinned: true });

    expect(answer).toEqual({ applied: true, outcome: { landed: [
      { formKey: '000801:A.esp', plugin }, { formKey: '000802:A.esp', plugin },
    ], refused: [] } });
    expect(executed().filter(([id]) => id === 'vscode.openWith').map(([, uri, , options]) => [String(uri), options]))
      .toEqual([['modbench-rendered:/ModA/A.esp/Gun.json?formKey=000801%3AA.esp&name=A.esp&origin=ModA', { viewColumn: -1, preview: false }]]);
    expect(pickRecord).not.toHaveBeenCalled();
    expect(reporter.report).not.toHaveBeenCalled();
  });

  it('answers a refusal naming the reason, and reports nothing to the user', async () => {
    register({ meditClient: openingAs(null) });

    const answer = await call(['000801:A.esp']);

    expect(answer).toMatchObject({ applied: false, refusal: 'Failed to open "000801:A.esp".' });
    expect(reporter.report).not.toHaveBeenCalled();
  });

  it('refuses a call with no record rather than opening the selection', async () => {
    register({ selection: () => [{ argument: { kind: 'record', formKey: '0009:A.esp', plugin } }] });

    await expect(Promise.resolve(call([]))).rejects.toThrow('takes at least one record');
    expect(executed()).toEqual([]);
  });

  it('opens a winning copy, resolved, when the record names no plugin', async () => {
    const meditClient = openingAs({ kind: 'Rendered', location: 'Gun.json' });
    meditClient.setQueryAnswer('getRecordOwner', plugin);
    register({ meditClient });

    const answer = await commandHandlers.get('modbench.record.open')?.(new AgentCall([{ kind: 'record', formKey: '000801:A.esp' }], {}));

    expect(answer).toMatchObject({ applied: true, outcome: { landed: [{ formKey: '000801:A.esp', plugin }] } });
  });
});
