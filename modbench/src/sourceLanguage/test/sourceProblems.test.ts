import { describe, it, expect, vi } from 'vitest';
import { feedSourceProblems, type ProblemsByFile } from '../sourceProblems';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { PluginProblems } from '../../client';
import type { NotificationEvent } from '../../client/apiClient';
import type { OriginFilesOf } from '../../instanceLoader/loadOrderSnapshot';

const MISSING = '000ABC:Absent.esp';
const REFERRER = '000800:Refers.esp';
const PLUGIN = { name: 'Refers.esp', origin: 'ReferringMod' };

const problem = (over: Partial<PluginProblems['problems'][number]> = {}): PluginProblems['problems'][number] => ({
  formKey: REFERRER, targetFormKey: MISSING, sourceRelativePath: 'Refers.esp/Npc.json', message: `Race: [${MISSING}] <Error: Could not be resolved>`, ...over,
});

const loadOrderStatus = (conflictsComputed: boolean): NotificationEvent => ({
  kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
  loadOrderStatus: { state: conflictsComputed ? 'Ready' : 'Reconciling', totalPlugins: 1, activePlugins: 1, indexedPlugins: [], conflictsComputed, failures: [], version: 1 },
});
const ready = loadOrderStatus(true);

const modFolders: OriginFilesOf = (origin) => ({ file: (relativePath) => `/mods/${origin}/${relativePath}` });

function feed(files: Record<string, string>, originFiles = modFolders) {
  const client = new InMemoryMEditClient();
  const published: ProblemsByFile[] = [];
  const reporter = { report: vi.fn(), shownOnSurface: vi.fn() };
  feedSourceProblems({
    client,
    originFiles,
    readFile: (path) => path in files ? Promise.resolve(files[path] ?? '') : Promise.reject(new Error(`no ${path}`)),
    reporter,
    publish: (problems) => published.push(problems),
  });
  const answered = async (answer: PluginProblems[], event: NotificationEvent = ready): Promise<ProblemsByFile> => {
    const before = published.length;
    client.setQueryAnswer('getPluginProblems', answer);
    client.emit(event);
    await vi.waitFor(() => { expect(published.length).toBeGreaterThan(before); });
    return published[published.length - 1] ?? new Map();
  };
  return { client, reporter, published, answered };
}

describe('feedSourceProblems (plugin-source.md, In the text editor, story 6)', () => {
  it('puts a reference to a missing record on its file, spanning the FormKey no active plugin holds', async () => {
    const text = `{\n  "FormKey": "${REFERRER}",\n  "Race": "${MISSING}"\n}`;
    const { answered } = feed({ '/mods/ReferringMod/Refers.esp/Npc.json': text });

    const shown = await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    expect([...shown]).toEqual([['/mods/ReferringMod/Refers.esp/Npc.json', [{
      message: `Race: [${MISSING}] <Error: Could not be resolved>`,
      start: { line: 2, character: 10 },
      end: { line: 2, character: 10 + MISSING.length + 2 },
    }]]]);
  });

  it('spans each child record\'s own reference when several records of one file cite the same missing record', async () => {
    const lines = ['{', '  "FormKey": "000800:Refers.esp",', '  "Temporary": [',
      `    { "FormKey": "000801:Refers.esp", "Base": "${MISSING}" },`,
      `    { "FormKey": "000802:Refers.esp", "Base": "${MISSING}" }`, '  ]', '}'];
    const { answered } = feed({ '/mods/ReferringMod/Refers.esp/Cell.json': lines.join('\n') });
    const placed = (formKey: string) => problem({ formKey, sourceRelativePath: 'Refers.esp/Cell.json', message: formKey });

    const shown = await answered([{ plugin: PLUGIN, problems: [placed('000802:Refers.esp'), placed('000801:Refers.esp')] }]);

    expect(shown.get('/mods/ReferringMod/Refers.esp/Cell.json')?.map(({ message, start }) => [message, start.line])).toEqual([
      ['000802:Refers.esp', 4], ['000801:Refers.esp', 3],
    ]);
  });

  it('keeps a problem at the first line of a file that does not spell its missing record', async () => {
    const { answered } = feed({ '/mods/ReferringMod/Refers.esp/Npc.json': `{ "FormKey": "${REFERRER}" }` });

    const shown = await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    expect(shown.get('/mods/ReferringMod/Refers.esp/Npc.json')?.map(({ start, end }) => [start, end])).toEqual([
      [{ line: 0, character: 0 }, { line: 0, character: 0 }],
    ]);
  });

  it.each([
    ['a save re-derives its rows', 'rows-changed'],
    ['mEdit re-reads its plugin', 'plugin-changed'],
  ])('clears a problem when %s and mEdit answers none', async (_, kind) => {
    const { answered } = feed({ '/mods/ReferringMod/Refers.esp/Npc.json': `"${MISSING}"` });
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    const shown = await answered([{ plugin: PLUGIN, problems: [] }], { kind, plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [REFERRER], sequence: 1 });

    expect([...shown]).toEqual([]);
  });

  it('asks again when the notification stream reconnects', async () => {
    const { client, answered, published } = feed({ '/mods/ReferringMod/Refers.esp/Npc.json': `"${MISSING}"` });
    await answered([]);

    client.setQueryAnswer('getPluginProblems', [{ plugin: PLUGIN, problems: [problem()] }]);
    client.reconnected();

    await vi.waitFor(() => { expect(published.at(-1)?.size).toBe(1); });
  });

  it('asks nothing while the index is not ready', async () => {
    const { client, answered } = feed({});
    client.emit(loadOrderStatus(false));

    await answered([]);

    expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(1);
  });

  it('tells of a plugin whose problems mEdit could not place, once while the reason stands and again when it changes', async () => {
    const { answered, reporter } = feed({});
    const failed = (failure: string): PluginProblems[] => [{ plugin: PLUGIN, problems: [], failure }];

    await answered(failed('Refers.esp\'s source holds no file for 000800:Refers.esp.'));
    await answered(failed('Refers.esp\'s source holds no file for 000800:Refers.esp.'));
    await answered(failed('Refers.esp is tracked but no mod folder provides it.'));

    expect(reporter.report.mock.calls).toEqual([
      ['warning', 'The Problems panel cannot show "Refers.esp"\'s problems.', 'Refers.esp\'s source holds no file for 000800:Refers.esp.'],
      ['warning', 'The Problems panel cannot show "Refers.esp"\'s problems.', 'Refers.esp is tracked but no mod folder provides it.'],
    ]);
  });

  it('tells of a plugin whose mod the instance holds no folder for, rather than dropping its problems', async () => {
    const { answered, reporter } = feed({}, () => undefined);

    await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    expect(reporter.report.mock.calls).toEqual([
      ['warning', 'The Problems panel cannot show "Refers.esp"\'s problems.', 'The instance holds no folder for ReferringMod.'],
    ]);
  });

  it('keeps the last answer when mEdit cannot answer, saying so in the Output once for each reason', async () => {
    const { client, answered, published, reporter } = feed({ '/mods/ReferringMod/Refers.esp/Npc.json': `"${MISSING}"` });
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);
    client.setQueryFailureOnce('getPluginProblems', new Error('getPluginProblems timed out after 30000ms'));
    client.setQueryFailureOnce('getPluginProblems', new Error('getPluginProblems timed out after 30000ms'));

    client.emit(ready);
    client.emit(ready);
    await vi.waitFor(() => { expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(3); });
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    expect(published).toHaveLength(2);
    expect(reporter.shownOnSurface.mock.calls).toEqual([
      ['warning', 'The Problems panel shows mEdit\'s last answer.', 'getPluginProblems timed out after 30000ms'],
    ]);
  });

  it('publishes no answer that a later one overtook', async () => {
    const { client, answered, published } = feed({ '/mods/ReferringMod/Refers.esp/Npc.json': `"${MISSING}"` });
    let overtaken!: (answer: PluginProblems[]) => void;
    client.setQueryAnswerOnce('getPluginProblems', new Promise<PluginProblems[]>((resolve) => { overtaken = resolve; }));
    client.emit(ready);

    await answered([]);
    overtaken([{ plugin: PLUGIN, problems: [problem()] }]);
    await answered([]);

    expect(published.map((problems) => problems.size)).toEqual([0, 0]);
  });
});
