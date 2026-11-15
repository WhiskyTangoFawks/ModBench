import { describe, it, expect, vi, afterEach } from 'vitest';
import { problemsAsker } from '../../drivingLib/problemsAsker';
import { feedSourceProblems, type ProblemsByFile } from '../sourceProblems';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordingReporter } from '../../test/surfacingDoubles';
import type { PluginProblems } from '../../client';
import { loadOrderStatusEventFixture } from '../../client/test/fixtures';
import type { NotificationEvent } from '../../client/apiClient';
import type { SourceFilesOf } from '../../instanceLoader/loadOrderSnapshot';

const RETRY_AFTER_MS = 1000;
const MISSING = '000ABC:Absent.esp';
const REFERRER = '000800:Refers.esp';
const PLUGIN = { name: 'Refers.esp', origin: 'ReferringMod' };

const problem = (over: Partial<PluginProblems['problems'][number]> = {}): PluginProblems['problems'][number] => ({
  formKey: REFERRER, targetFormKey: MISSING, fieldPath: 'Race', sourceRelativePath: 'Refers.esp/Npc.json', message: `Race: [${MISSING}] <Error: Could not be resolved>`, ...over,
});

let version = 0;
const RECONCILING = { state: 'Reconciling', conflictsComputed: false } as const;
const reconciledAgain = (client: InMemoryMEditClient) => {
  client.emit(loadOrderStatusEventFixture({ ...RECONCILING, version }));
  version += 1;
  client.emit(loadOrderStatusEventFixture({ state: 'Ready', conflictsComputed: true, version }));
};

const sourceFolders: SourceFilesOf = (origin) => ({ file: (relativePath) => `/source/${origin}/${relativePath}` });

function feed(sourceFiles = sourceFolders, answeredAtSubscribe?: PluginProblems[] | PromiseLike<PluginProblems[]>) {
  const client = new InMemoryMEditClient();
  if (answeredAtSubscribe) client.setQueryAnswerOnce('getPluginProblems', answeredAtSubscribe);
  const published: ProblemsByFile[] = [];
  const reporter = recordingReporter();
  const status: (string | undefined)[] = [];
  const unsaved: (string | undefined)[] = [];
  feedSourceProblems({
    client,
    ask: problemsAsker(client, RETRY_AFTER_MS),
    sourceFiles,
    reporter,
    publish: (problems) => published.push(problems),
    languageStatus: (text) => status.push(text),
    unsavedStatus: (text) => unsaved.push(text),
  });
  const answered = async (answer: PluginProblems[], event?: NotificationEvent): Promise<ProblemsByFile> => {
    const before = published.length;
    client.setQueryAnswer('getPluginProblems', answer);
    if (event) client.emit(event); else reconciledAgain(client);
    await vi.waitFor(() => { expect(published.length).toBeGreaterThan(before); });
    return published[published.length - 1] ?? new Map();
  };
  return { client, reporter, published, status, unsaved, answered };
}

afterEach(() => { vi.useRealTimers(); });

describe('feedSourceProblems (source.md, Editing plugin source, story 1)', () => {
  const RECORD = { formKey: REFERRER, plugin: 'Refers.esp', origin: 'ReferringMod' };
  const ITEMS = { kind: 'member', name: 'Items' };
  it.each([
    ['a member', 'Race', { label: 'clear reference', command: 'modbench.record.editField', args: [RECORD, { op: 'set', path: [{ kind: 'member', name: 'Race' }], value: null }] }],
    ['a member of a list element', 'Items[0].Item', { label: 'clear reference', command: 'modbench.record.editField', args: [RECORD, { op: 'set', path: [ITEMS, { kind: 'index', index: 0 }, { kind: 'member', name: 'Item' }], value: null }] }],
    ['a list element', 'Items[1]', { label: 'remove element', command: 'modbench.record.removeElement', args: [{ ...RECORD, path: [ITEMS, { kind: 'index', index: 1 }] }] }],
  ])('carries the gesture that clears a reference in %s, on the copy that holds it', async (_label, fieldPath, gesture) => {
    const { answered } = feed();

    const shown = await answered([{ plugin: PLUGIN, problems: [problem({ fieldPath })] }]);

    expect(shown.get('/source/ReferringMod/Refers.esp/Npc.json')?.map(({ clearing }) => clearing)).toEqual([gesture]);
  });

  it.each([
    ['names no field', { fieldPath: null }],
    ['is a link that was not checked, for it is not known to be missing', { fieldPath: 'Race', uncheckedBecause: 'Unreadable.esp' }],
  ])('carries no clearing edit on a problem that %s', async (_label, given) => {
    const { answered } = feed();

    const shown = await answered([{ plugin: PLUGIN, problems: [problem(given)] }]);

    expect(shown.get('/source/ReferringMod/Refers.esp/Npc.json')?.map(({ clearing }) => clearing)).toEqual([undefined]);
  });

  it('puts a problem on its file at the range mEdit answered', async () => {
    const range = { start: { line: 2, character: 10 }, end: { line: 2, character: 31 } };
    const { answered } = feed();

    const shown = await answered([{ plugin: PLUGIN, problems: [problem({ range })] }]);

    expect([...shown]).toEqual([['/source/ReferringMod/Refers.esp/Npc.json', [expect.objectContaining({
      message: `Race: [${MISSING}] <Error: Could not be resolved>`,
      ...range,
    })]]]);
  });

  it('puts a problem mEdit answered no range for on the first line', async () => {
    const { answered } = feed();

    const shown = await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    expect(shown.get('/source/ReferringMod/Refers.esp/Npc.json')?.map(({ start, end }) => [start, end])).toEqual([
      [{ line: 0, character: 0 }, { line: 0, character: 0 }],
    ]);
  });

  it.each([
    ['a save re-derives its rows', 'rows-changed'],
    ['mEdit re-reads its plugin', 'plugin-changed'],
  ])('clears a problem when %s and mEdit answers none', async (_, kind) => {
    const { answered } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    const shown = await answered([{ plugin: PLUGIN, problems: [] }], { kind, plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [REFERRER], sequence: 1 });

    expect([...shown]).toEqual([]);
  });

  it('asks nothing when a plugin\'s failure arrives mid-reconcile, since mEdit would answer that it is not ready', () => {
    const { client } = feed();
    const asked = () => client.calls.filter(({ method }) => method === 'getPluginProblems').length;
    const before = asked();

    client.emit(loadOrderStatusEventFixture({ ...RECONCILING, failures: [{ name: 'Bad.esp', origin: 'Mod', reason: 'truncated' }] }));

    expect(asked()).toBe(before);
  });

  it('shows mEdit\'s answer at subscribe, and asks again on a save before any load-order-status', async () => {
    const { client, published } = feed(sourceFolders, [{ plugin: PLUGIN, problems: [problem()] }]);
    await vi.waitFor(() => { expect(published.map((problems) => problems.size)).toEqual([1]); });

    client.setQueryAnswer('getPluginProblems', [{ plugin: PLUGIN, problems: [] }]);
    client.emit({ kind: 'rows-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [REFERRER], sequence: 1 });

    await vi.waitFor(() => { expect(published.map((problems) => problems.size)).toEqual([1, 0]); });
  });

  it('says nothing when mEdit cannot answer at subscribe, and asks nothing on a save until the record index is ready', async () => {
    const refused = Promise.reject(new Error('mEdit is down.'));
    const { client, reporter, answered } = feed(sourceFolders, refused);
    await refused.catch(() => undefined);
    client.emit({ kind: 'rows-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [REFERRER], sequence: 1 });

    await answered([]);

    expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(2);
    expect(reporter.shownFailures).toEqual([]);
  });

  it('asks nothing on a save when the record index began reconciling while the ask at subscribe was in flight', async () => {
    let answer!: (problems: PluginProblems[]) => void;
    const { client, published, answered } = feed(sourceFolders, new Promise<PluginProblems[]>((resolve) => { answer = resolve; }));
    client.emit(loadOrderStatusEventFixture(RECONCILING));
    answer([]);
    await vi.waitFor(() => { expect(published).toHaveLength(1); });
    client.emit({ kind: 'rows-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [REFERRER], sequence: 1 });

    await answered([]);

    expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(2);
  });

  it.each(['rows-changed', 'plugin-changed'])('asks nothing on %s while the record index reconciles', async (kind) => {
    const { client, answered } = feed();
    await answered([]);
    client.emit(loadOrderStatusEventFixture(RECONCILING));
    client.emit({ kind, plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [REFERRER], sequence: 1 });

    await answered([]);

    expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(2);
  });

  it('asks again for only the plugin a notification names, and keeps the problems of the others', async () => {
    const other = { name: 'Other.esp', origin: 'OtherMod' };
    const { client, answered } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }, { plugin: other, problems: [problem({ sourceRelativePath: 'Other.esp/Npc.json' })] }]);

    const shown = await answered([{ plugin: PLUGIN, problems: [] }], { kind: 'rows-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [REFERRER], sequence: 1 });

    expect([[...shown.keys()], client.calls.filter(({ method }) => method === 'getPluginProblems').map(({ args }) => args).at(-1)])
      .toEqual([['/source/OtherMod/Other.esp/Npc.json'], [PLUGIN]]);
  });

  it('drops the problems of a plugin that a notification names and mEdit answers no entry for', async () => {
    const { answered } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    const shown = await answered([], { kind: 'plugin-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [], sequence: 1 });

    expect([...shown]).toEqual([]);
  });

  it('asks for every plugin when the load order settles', async () => {
    const { client, answered } = feed();
    await answered([]);

    expect(client.calls.filter(({ method }) => method === 'getPluginProblems').map(({ args }) => args).at(-1)).toEqual([undefined]);
  });

  it('keeps one ask in flight and at most one pending, however many notifications arrive meanwhile', async () => {
    const { client, published } = feed(sourceFolders, [{ plugin: PLUGIN, problems: [] }]);
    await vi.waitFor(() => { expect(published).toHaveLength(1); });
    let answerFirst!: (answer: PluginProblems[]) => void;
    client.setQueryAnswerOnce('getPluginProblems', new Promise<PluginProblems[]>((resolve) => { answerFirst = resolve; }));
    const named = (sequence: number): NotificationEvent => ({ kind: 'rows-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [REFERRER], sequence });
    client.emit(named(1));
    await vi.waitFor(() => { expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(2); });

    for (let sequence = 2; sequence < 6; sequence += 1) client.emit(named(sequence));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(2);

    answerFirst([]);
    await vi.waitFor(() => { expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(3); });
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(3);
  });

  it('adds no line for a failure mEdit answers, however its text changes, and keeps the language status current', async () => {
    const { answered, reporter, status } = feed();
    const failed = (failure: string): PluginProblems[] => [{ plugin: PLUGIN, problems: [], failure, failureKind: 'LaterRead' }];

    await answered(failed('Unexpected end at 1.'));
    await answered(failed('Unexpected end at 2.'));
    await answered([{ plugin: PLUGIN, problems: [] }]);
    await answered(failed('Unexpected end at 3.'));

    expect(reporter.shownFailures).toEqual([]);
    expect(status.at(-1)).toBe('Showing the last good read: "Refers.esp" (ReferringMod): Unexpected end at 3.');
  });

  it('tells of a placement failure once while its reason stands and again when it changes', async () => {
    const { answered, reporter } = feed();
    const failed = (failure: string): PluginProblems[] => [{ plugin: PLUGIN, problems: [], failure, failureKind: 'Placement' }];

    await answered(failed('Refers.esp\'s source holds no file for 000800:Refers.esp.'));
    await answered(failed('Refers.esp\'s source holds no file for 000800:Refers.esp.'));
    await answered(failed('Refers.esp is a compiled plugin but no mod folder provides it.'));

    expect(reporter.shownFailures).toEqual([
      { severity: 'warning', message: 'The Problems panel keeps the last problems of "Refers.esp" (ReferringMod).', detail: 'Refers.esp\'s source holds no file for 000800:Refers.esp.' },
      { severity: 'warning', message: 'The Problems panel keeps the last problems of "Refers.esp" (ReferringMod).', detail: 'Refers.esp is a compiled plugin but no mod folder provides it.' },
    ]);
  });

  it('shows the problems mEdit placed for a plugin whose other problems it could not place', async () => {
    const { answered, reporter } = feed();
    const stray = problem({ formKey: null, targetFormKey: null, fieldPath: null, sourceRelativePath: 'Refers.esp/Stray.json', message: 'unreadable' });

    const shown = await answered([{ plugin: PLUGIN, problems: [stray], failure: 'Refers.esp\'s source could not place 000800:Refers.esp.', failureKind: 'Placement' }]);

    expect([...shown.keys()]).toEqual(['/source/ReferringMod/Refers.esp/Stray.json']);
    expect(reporter.shownFailures).toEqual([
      { severity: 'warning', message: 'The Problems panel keeps the last problems of "Refers.esp" (ReferringMod).', detail: 'Refers.esp\'s source could not place 000800:Refers.esp.' },
    ]);
  });

  it('tells of a plugin whose mod the instance holds no source folder for, rather than dropping its problems', async () => {
    const { answered, reporter } = feed(() => undefined);

    await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    expect(reporter.shownFailures).toEqual([
      { severity: 'warning', message: 'The Problems panel keeps the last problems of "Refers.esp" (ReferringMod).', detail: 'The instance holds no source folder for ReferringMod.' },
    ]);
  });

  it('keeps the last answer when mEdit cannot answer, saying so in the Output once for each reason', async () => {
    const { client, answered, published, reporter } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);
    client.setQueryFailureOnce('getPluginProblems', { failed: 'timed-out' });
    client.setQueryFailureOnce('getPluginProblems', { failed: 'timed-out' });

    reconciledAgain(client);
    await vi.waitFor(() => { expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(2); });
    reconciledAgain(client);
    await vi.waitFor(() => { expect(client.calls.filter(({ method }) => method === 'getPluginProblems')).toHaveLength(3); });
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    expect(published).toHaveLength(2);
    expect(reporter.shownFailures).toEqual([
      { severity: 'warning', message: 'The Problems panel shows mEdit\'s last answer.', detail: 'mEdit did not answer in time.' },
    ]);
  });

  it('says in the language status that it shows the last good read, and why, until the next good answer clears it', async () => {
    const { client, answered, status } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);
    client.setQueryFailureOnce('getPluginProblems', { failed: 'timed-out' });
    reconciledAgain(client);
    await vi.waitFor(() => { expect(status.at(-1)).toBe('Showing the last good read: mEdit did not answer in time.'); });

    await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    expect(status.at(-1)).toBeUndefined();
  });

  it('asks again after a delay of an ask that failed, with no event between, and publishes its answer', async () => {
    const { client, answered, published, status } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);
    vi.useFakeTimers();
    client.setQueryFailureOnce('getPluginProblems', { failed: 'timed-out' });
    reconciledAgain(client);
    await vi.waitFor(() => { expect(status.at(-1)).toBe('Showing the last good read: mEdit did not answer in time.'); });
    client.setQueryAnswer('getPluginProblems', []);

    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);

    expect([published.at(-1), status.at(-1)]).toEqual([new Map(), undefined]);
  });

  it('keeps the problems of a plugin mEdit cannot place while the rest publishes, and says so in the language status', async () => {
    const other = { name: 'Other.esp', origin: 'OtherMod' };
    const { answered, status } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }, { plugin: other, problems: [] }]);
    const why = 'Refers.esp is a compiled plugin but no mod folder provides it.';

    const shown = await answered([
      { plugin: PLUGIN, problems: [], failure: why },
      { plugin: other, problems: [problem({ sourceRelativePath: 'Other.esp/Npc.json' })] },
    ]);

    expect([...shown.keys()].sort()).toEqual(['/source/OtherMod/Other.esp/Npc.json', '/source/ReferringMod/Refers.esp/Npc.json']);
    expect(status.at(-1)).toBe(`Showing the last good read: "Refers.esp" (ReferringMod): ${why}`);
  });

  it('drops the kept problems of a plugin once mEdit places it again', async () => {
    const { answered, status } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);
    await answered([{ plugin: PLUGIN, problems: [], failure: 'unplaced' }]);

    const shown = await answered([{ plugin: PLUGIN, problems: [] }]);

    expect([...shown]).toEqual([]);
    expect(status.at(-1)).toBeUndefined();
  });

  it('names every unplaced plugin in one language status line', async () => {
    const other = { name: 'Other.esp', origin: 'OtherMod' };
    const { answered, status } = feed();

    await answered([{ plugin: PLUGIN, problems: [], failure: 'one' }, { plugin: other, problems: [], failure: 'two' }]);

    expect(status.at(-1)).toBe('Showing the last good read: "Refers.esp" (ReferringMod): one; "Other.esp" (OtherMod): two');
  });

  describe('for a plugin mEdit cannot place', () => {
    const FILE = '/source/ReferringMod/Refers.esp/Npc.json';
    const stop = (message: string) => problem({ formKey: null, targetFormKey: null, fieldPath: null, message });
    const unplaced = (...problems: PluginProblems['problems']): PluginProblems[] => [{ plugin: PLUGIN, problems, failure: 'unplaced' }];
    const messagesOn = (shown: ProblemsByFile) => shown.get(FILE)?.map(({ message }) => message);

    it('keeps the links of a file that now stops a read, beside the stop', async () => {
      const { answered } = feed();
      await answered([{ plugin: PLUGIN, problems: [problem({ message: 'link' })] }]);

      const shown = await answered(unplaced(stop('stopped')));

      expect(messagesOn(shown)).toEqual(['stopped', 'link']);
    });

    it('drops a stop that was fixed', async () => {
      const { answered } = feed();
      await answered(unplaced(stop('stopped')));

      const shown = await answered(unplaced());

      expect([...shown]).toEqual([]);
    });
  });

});

describe('feedSourceProblems, when mEdit cannot take the unsaved plugin source', () => {
  const lastRead = (why: string) => `Showing the last good read: mEdit could not take the unsaved plugin source: ${why}`;

  it('says so in the language status, with one line in the Output for a reason told again', () => {
    const { client, reporter, status } = feed();

    client.settleHandOver({ failed: 'refused', refusal: 'connection reset' });
    client.settleHandOver({ failed: 'refused', refusal: 'connection reset' });

    expect(status.at(-1)).toBe(lastRead('connection reset'));
    expect(reporter.shownFailures).toEqual([
      { severity: 'warning', message: 'The Problems panel shows what mEdit last took of the unsaved plugin source.', detail: 'connection reset' },
    ]);
  });

  it('clears the language status once the next hand-over lands', () => {
    const { client, status } = feed();
    client.settleHandOver({ failed: 'refused', refusal: 'connection reset' });

    client.settleHandOver(undefined);

    expect(status.at(-1)).toBeUndefined();
  });

  it('gives the line alone, so a read of a record can carry it, and clears it with the next hand-over', () => {
    const { client, unsaved } = feed();

    client.settleHandOver({ failed: 'refused', refusal: 'connection reset' });
    client.settleHandOver(undefined);

    expect(unsaved).toEqual([lastRead('connection reset'), undefined]);
  });

  it('gives no line for an ask of the Problems panel that failed', async () => {
    const { client, status, unsaved, answered } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);
    client.setQueryFailureOnce('getPluginProblems', { failed: 'timed-out' });
    reconciledAgain(client);
    await vi.waitFor(() => { expect(status.at(-1)).toContain('mEdit did not answer in time.'); });

    expect(unsaved.filter((line) => line !== undefined)).toEqual([]);
  });
});
