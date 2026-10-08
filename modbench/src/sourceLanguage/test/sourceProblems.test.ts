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
  formKey: REFERRER, targetFormKey: MISSING, fieldPath: 'Race', sourceRelativePath: 'Refers.esp/Npc.json', message: `Race: [${MISSING}] <Error: Could not be resolved>`, ...over,
});

const loadOrderStatus = (conflictsComputed: boolean): NotificationEvent => ({
  kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
  loadOrderStatus: { state: conflictsComputed ? 'Ready' : 'Reconciling', totalPlugins: 1, activePlugins: 1, indexedPlugins: [], conflictsComputed, failures: [], version: 1 },
});
const ready = loadOrderStatus(true);

const modFolders: OriginFilesOf = (origin) => ({ file: (relativePath) => `/mods/${origin}/${relativePath}` });

function feed(files: Record<string, string>, originFiles = modFolders, answeredAtSubscribe?: PluginProblems[] | PromiseLike<PluginProblems[]>) {
  const client = new InMemoryMEditClient();
  if (answeredAtSubscribe) client.setQueryAnswerOnce('getPluginProblems', answeredAtSubscribe);
  const published: ProblemsByFile[] = [];
  const reporter = { shownOnSurface: vi.fn() };
  const status: (string | undefined)[] = [];
  feedSourceProblems({
    client,
    originFiles,
    readText: (path) => path in files ? Promise.resolve(files[path] ?? '') : Promise.reject(new Error(`no ${path}`)),
    reporter,
    publish: (problems) => published.push(problems),
    languageStatus: (text) => status.push(text),
  });
  const answered = async (answer: PluginProblems[], event: NotificationEvent = ready): Promise<ProblemsByFile> => {
    const before = published.length;
    client.setQueryAnswer('getPluginProblems', answer);
    client.emit(event);
    await vi.waitFor(() => { expect(published.length).toBeGreaterThan(before); });
    return published[published.length - 1] ?? new Map();
  };
  return { client, reporter, published, status, answered };
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

  it('spans the FormKey a file declares when another file claims it too', async () => {
    const text = `{\n  "FormKey": "${REFERRER}",\n  "Race": "${MISSING}"\n}`;
    const { answered } = feed({ '/mods/ReferringMod/Refers.esp/Npc.json': text });

    const shown = await answered([{ plugin: PLUGIN, problems: [problem({ targetFormKey: null, message: 'claimed twice' })] }]);

    expect(shown.get('/mods/ReferringMod/Refers.esp/Npc.json')?.map(({ start, end }) => [start, end])).toEqual([
      [{ line: 1, character: 13 }, { line: 1, character: 13 + REFERRER.length + 2 }],
    ]);
  });

  it('spans each link at its own field path when one record names the same missing record in many', async () => {
    const items = Array.from({ length: 11 }, () => `    { "Item": "${MISSING}" }`);
    const text = ['{', `  "FormKey": "${REFERRER}",`, `  "Voice": "${MISSING}",`, '  "Items": [', items.join(',\n'), '  ]', '}'].join('\n');
    const { answered } = feed({ '/mods/ReferringMod/Refers.esp/Npc.json': text });
    const at = (fieldPath: string) => problem({ fieldPath, message: fieldPath });

    const shown = await answered([{ plugin: PLUGIN, problems: [at('Items[10].Item'), at('Items[2].Item'), at('Voice')] }]);

    expect(shown.get('/mods/ReferringMod/Refers.esp/Npc.json')?.map(({ message, start }) => [message, start.line])).toEqual([
      ['Items[10].Item', 14], ['Items[2].Item', 6], ['Voice', 2],
    ]);
  });

  it('keeps a problem whose file it cannot read at the first line, saying why in the Output once', async () => {
    const { answered, reporter } = feed({});

    await answered([{ plugin: PLUGIN, problems: [problem()] }]);
    const shown = await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    expect(shown.get('/mods/ReferringMod/Refers.esp/Npc.json')?.map(({ start }) => start)).toEqual([{ line: 0, character: 0 }]);
    expect(reporter.shownOnSurface.mock.calls).toEqual([
      ['warning', 'The Problems panel shows the problems of "/mods/ReferringMod/Refers.esp/Npc.json" on its first line.', 'no /mods/ReferringMod/Refers.esp/Npc.json'],
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

    expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(2);
  });

  it('shows mEdit\'s answer at subscribe, and asks again on a save before any load-order-status', async () => {
    const { client, published } = feed({ '/mods/ReferringMod/Refers.esp/Npc.json': `"${MISSING}"` }, modFolders, [{ plugin: PLUGIN, problems: [problem()] }]);
    await vi.waitFor(() => { expect(published.map((problems) => problems.size)).toEqual([1]); });

    client.setQueryAnswer('getPluginProblems', [{ plugin: PLUGIN, problems: [] }]);
    client.emit({ kind: 'rows-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [REFERRER], sequence: 1 });

    await vi.waitFor(() => { expect(published.map((problems) => problems.size)).toEqual([1, 0]); });
  });

  it('says nothing when mEdit cannot answer at subscribe, and asks nothing on a save until the index is ready', async () => {
    const { client, reporter, answered } = feed({});
    await new Promise((settled) => { setTimeout(settled, 0); });
    client.emit({ kind: 'rows-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [REFERRER], sequence: 1 });

    await answered([]);

    expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(2);
    expect(reporter.shownOnSurface).not.toHaveBeenCalled();
  });

  it('asks nothing on a save when the index began reconciling while the ask at subscribe was in flight', async () => {
    let answer!: (problems: PluginProblems[]) => void;
    const { client, published, answered } = feed({}, modFolders, new Promise<PluginProblems[]>((resolve) => { answer = resolve; }));
    client.emit(loadOrderStatus(false));
    answer([]);
    await vi.waitFor(() => { expect(published).toHaveLength(1); });
    client.emit({ kind: 'rows-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [REFERRER], sequence: 1 });

    await answered([]);

    expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(2);
  });

  it.each(['rows-changed', 'plugin-changed'])('asks nothing on %s while the index reconciles', async (kind) => {
    const { client, answered } = feed({});
    await answered([]);
    client.emit(loadOrderStatus(false));
    client.emit({ kind, plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [REFERRER], sequence: 1 });

    await answered([]);

    expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(3);
  });

  it('tells of a plugin whose problems mEdit could not place, once while the reason stands and again when it changes', async () => {
    const { answered, reporter } = feed({});
    const failed = (failure: string): PluginProblems[] => [{ plugin: PLUGIN, problems: [], failure }];

    await answered(failed('Refers.esp\'s source holds no file for 000800:Refers.esp.'));
    await answered(failed('Refers.esp\'s source holds no file for 000800:Refers.esp.'));
    await answered(failed('Refers.esp is tracked but no mod folder provides it.'));

    expect(reporter.shownOnSurface.mock.calls).toEqual([
      ['warning', 'The Problems panel cannot show "Refers.esp"\'s problems.', 'Refers.esp\'s source holds no file for 000800:Refers.esp.'],
      ['warning', 'The Problems panel cannot show "Refers.esp"\'s problems.', 'Refers.esp is tracked but no mod folder provides it.'],
    ]);
  });

  it('shows the problems mEdit placed for a plugin whose other problems it could not place', async () => {
    const { answered, reporter } = feed({ '/mods/ReferringMod/Refers.esp/Stray.json': '{' });
    const stray = problem({ formKey: null, targetFormKey: null, fieldPath: null, sourceRelativePath: 'Refers.esp/Stray.json', message: 'unreadable' });

    const shown = await answered([{ plugin: PLUGIN, problems: [stray], failure: 'Refers.esp\'s source could not place 000800:Refers.esp.' }]);

    expect([...shown.keys()]).toEqual(['/mods/ReferringMod/Refers.esp/Stray.json']);
    expect(reporter.shownOnSurface.mock.calls).toEqual([
      ['warning', 'The Problems panel cannot show "Refers.esp"\'s problems.', 'Refers.esp\'s source could not place 000800:Refers.esp.'],
    ]);
  });

  it('tells of a plugin whose mod the instance holds no folder for, rather than dropping its problems', async () => {
    const { answered, reporter } = feed({}, () => undefined);

    await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    expect(reporter.shownOnSurface.mock.calls).toEqual([
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
    await vi.waitFor(() => { expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(4); });
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

  it('says nothing of a failed ask that a later one overtook', async () => {
    const { client, answered, reporter } = feed({});
    let overtaken!: (error: Error) => void;
    client.setQueryAnswerOnce('getPluginProblems', new Promise<PluginProblems[]>((_, reject) => { overtaken = reject; }));
    client.emit(ready);

    await answered([]);
    overtaken(new Error('getPluginProblems timed out after 30000ms'));
    await answered([]);

    expect(reporter.shownOnSurface).not.toHaveBeenCalled();
  });

  it('publishes an older answer when the ask that overtook it fails', async () => {
    const { client, published } = feed({ '/mods/ReferringMod/Refers.esp/Npc.json': `"${MISSING}"` });
    let older!: (answer: PluginProblems[]) => void;
    client.setQueryAnswerOnce('getPluginProblems', new Promise<PluginProblems[]>((resolve) => { older = resolve; }));
    client.setQueryFailureOnce('getPluginProblems', new Error('getPluginProblems timed out after 30000ms'));
    client.emit(ready);
    client.emit(ready);
    await vi.waitFor(() => { expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(3); });

    older([{ plugin: PLUGIN, problems: [problem()] }]);

    await vi.waitFor(() => { expect(published.map((problems) => problems.size)).toEqual([1]); });
  });

  it('says in the language status that it shows the last good read, and why, until the next good answer clears it', async () => {
    const { client, answered, status } = feed({ '/mods/ReferringMod/Refers.esp/Npc.json': `"${MISSING}"` });
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);
    client.setQueryFailureOnce('getPluginProblems', new Error('getPluginProblems timed out after 30000ms'));
    client.emit(ready);
    await vi.waitFor(() => { expect(status.at(-1)).toBe('Showing the last good read: getPluginProblems timed out after 30000ms'); });

    await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    expect(status.at(-1)).toBeUndefined();
  });

  it('keeps the problems of a plugin mEdit cannot place while the rest publishes, and says so in the language status', async () => {
    const other = { name: 'Other.esp', origin: 'OtherMod' };
    const files = { '/mods/ReferringMod/Refers.esp/Npc.json': `"${MISSING}"`, '/mods/OtherMod/Other.esp/Npc.json': `"${MISSING}"` };
    const { answered, status } = feed(files);
    await answered([{ plugin: PLUGIN, problems: [problem()] }, { plugin: other, problems: [] }]);
    const why = 'Refers.esp is tracked but no mod folder provides it.';

    const shown = await answered([
      { plugin: PLUGIN, problems: [], failure: why },
      { plugin: other, problems: [problem({ sourceRelativePath: 'Other.esp/Npc.json' })] },
    ]);

    expect([...shown.keys()].sort()).toEqual(['/mods/OtherMod/Other.esp/Npc.json', '/mods/ReferringMod/Refers.esp/Npc.json']);
    expect(status.at(-1)).toBe(`Showing the last good read: "Refers.esp": ${why}`);
  });

  it('drops the kept problems of a plugin once mEdit places it again', async () => {
    const { answered, status } = feed({ '/mods/ReferringMod/Refers.esp/Npc.json': `"${MISSING}"` });
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);
    await answered([{ plugin: PLUGIN, problems: [], failure: 'unplaced' }]);

    const shown = await answered([{ plugin: PLUGIN, problems: [] }]);

    expect([...shown]).toEqual([]);
    expect(status.at(-1)).toBeUndefined();
  });

  it('names every unplaced plugin in one language status line', async () => {
    const other = { name: 'Other.esp', origin: 'OtherMod' };
    const { answered, status } = feed({});

    await answered([{ plugin: PLUGIN, problems: [], failure: 'one' }, { plugin: other, problems: [], failure: 'two' }]);

    expect(status.at(-1)).toBe('Showing the last good read: "Refers.esp": one; "Other.esp": two');
  });
});
