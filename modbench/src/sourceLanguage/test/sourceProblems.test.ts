import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { LINKS_STATUS, RETRY_AFTER_MS, sourceFolders, sourceLanguageOver } from './sourceLanguageOver';
import type { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { PluginProblems, RecordIndexChange } from '../../client';
import { EMPTY_SNAPSHOT } from '../../client/test/fixtures';
import { holdsLoadOrder, changeNamesPlugin } from '../../client/test/says';
import { settled as until } from '../../test/eventually';

const MISSING = '000ABC:Absent.esp';
const REFERRER = '000800:Refers.esp';
const PLUGIN = { name: 'Refers.esp', origin: 'ReferringMod' };

const problem = (over: Partial<PluginProblems['problems'][number]> = {}): PluginProblems['problems'][number] => ({
  formKey: REFERRER, targetFormKey: MISSING, fieldPath: 'Race', sourceRelativePath: 'Refers.esp/Npc.json', message: `Race: [${MISSING}] <Error: Could not be resolved>`, ...over,
});

let version = 0;
const reconciledAgain = (client: InMemoryMEditClient) => {
  version += 1;
  holdsLoadOrder(client, { settled: false, version });
  holdsLoadOrder(client, { version });
};

function late(client: InMemoryMEditClient): () => void {
  client.setStatus('running');
  let answer!: () => void;
  client.answerPuts(() => new Promise((resolve) => { answer = () => { resolve({ outcome: 'abandoned' }); }; }));
  void client.sendLoadOrder(EMPTY_SNAPSHOT);
  return () => { answer(); };
}

type Shown = Awaited<ReturnType<ReturnType<typeof sourceLanguageOver>['problems']>>;

function feed(sourceFiles = sourceFolders, answeredAtSubscribe?: PluginProblems[] | PromiseLike<PluginProblems[]>) {
  const made = sourceLanguageOver({ sourceFiles, arrange: (client) => { if (answeredAtSubscribe) client.setQueryAnswerOnce('getPluginProblems', answeredAtSubscribe); } });
  const { client, problems } = made;
  const answered = async (answer: PluginProblems[], change?: RecordIndexChange): Promise<Shown> => {
    client.setQueryAnswer('getPluginProblems', answer.map((each) => ({ ...each })));
    if (change) client.change(change); else reconciledAgain(client);
    return problems();
  };
  const status = () => host.status(LINKS_STATUS);
  return { ...made, status, answered, asked: () => made.asked('getPluginProblems') };
}

afterEach(() => { vi.useRealTimers(); });

const FILE = '/source/ReferringMod/Refers.esp/Npc.json';

describe('the links a plugin source holds to missing records, in the Problems panel (source.md, Editing plugin source, story 1)', () => {
  const RECORD = { formKey: REFERRER, plugin: 'Refers.esp', origin: 'ReferringMod' };
  const ITEMS = { kind: 'member', name: 'Items' };
  it.each([
    ['a member', 'Race', { label: 'clear reference', command: 'modbench.record.editField', args: [RECORD, { op: 'set', path: [{ kind: 'member', name: 'Race' }], value: null }] }],
    ['a member of a list element', 'Items[0].Item', { label: 'clear reference', command: 'modbench.record.editField', args: [RECORD, { op: 'set', path: [ITEMS, { kind: 'index', index: 0 }, { kind: 'member', name: 'Item' }], value: null }] }],
    ['a list element', 'Items[1]', { label: 'remove element', command: 'modbench.record.removeElement', args: [{ ...RECORD, path: [ITEMS, { kind: 'index', index: 1 }] }] }],
  ])('carries the gesture that clears a reference in %s, on the copy that holds it', async (_label, fieldPath, gesture) => {
    const { answered } = feed();

    const shown = await answered([{ plugin: PLUGIN, problems: [problem({ fieldPath })] }]);

    expect(shown.get(FILE)?.map(({ clearing }) => clearing)).toEqual([gesture]);
  });

  it.each([
    ['names no field', { fieldPath: null }],
    ['is a link that was not checked, for it is not known to be missing', { fieldPath: 'Race', uncheckedBecause: 'Unreadable.esp' }],
  ])('carries no clearing edit on a problem that %s', async (_label, given) => {
    const { answered } = feed();

    const shown = await answered([{ plugin: PLUGIN, problems: [problem(given)] }]);

    expect(shown.get(FILE)?.map(({ clearing }) => clearing)).toEqual([undefined]);
  });

  it('puts a problem on its file at the range mEdit answered', async () => {
    const range = { start: { line: 2, character: 10 }, end: { line: 2, character: 31 } };
    const { answered } = feed();

    const shown = await answered([{ plugin: PLUGIN, problems: [problem({ range })] }]);

    expect([...shown].map(([file, onFile]) => [file, onFile.map(({ message, start, end }) => ({ message, start, end }))]))
      .toEqual([[FILE, [{ message: `Race: [${MISSING}] <Error: Could not be resolved>`, ...range }]]]);
  });

  it('puts a problem mEdit answered no range for on the first line', async () => {
    const { answered } = feed();

    const shown = await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    expect(shown.get(FILE)?.map(({ start, end }) => [start, end])).toEqual([
      [{ line: 0, character: 0 }, { line: 0, character: 0 }],
    ]);
  });

  it.each([
    ['a save re-derives its rows', 'rows-changed'],
    ['mEdit re-reads its plugin', 'plugin-changed'],
  ])('clears a problem when %s and mEdit answers none', async (_, kind) => {
    const { answered } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    const shown = await answered([{ plugin: PLUGIN, problems: [] }], [{ plugin: { name: PLUGIN.name, origin: PLUGIN.origin }, ...(kind === 'rows-changed' && { keys: [REFERRER] }) }]);

    expect([...shown]).toEqual([]);
  });

  it('is settled only once the answer to a change is published', async () => {
    const { client, answered, language, asked } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);
    let answer: (answer: PluginProblems[]) => void = () => undefined;
    client.setQueryAnswerOnce('getPluginProblems', new Promise<PluginProblems[]>((resolve) => { answer = resolve; }));
    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin });
    const before = asked().length;

    let ended = false;
    const waiting = language.problemsCaughtUp().then(() => { ended = true; });
    await until(() => { expect(asked()).toHaveLength(before + 1); });
    expect(ended).toBe(false);
    answer([{ plugin: PLUGIN, problems: [] }]);
    await waiting;

    expect([...host.problems('modbench-source')]).toEqual([]);
  });

  it('stays unsettled for a call made while a run goes, until the run after it ends', async () => {
    const { client, problems, language, asked } = feed();
    await problems();
    let answerFirst: (answer: PluginProblems[]) => void = () => undefined;
    client.setQueryAnswerOnce('getPluginProblems', new Promise<PluginProblems[]>((resolve) => { answerFirst = resolve; }));
    let answerSecond: (answer: PluginProblems[]) => void = () => undefined;
    client.setQueryAnswerOnce('getPluginProblems', new Promise<PluginProblems[]>((resolve) => { answerSecond = resolve; }));
    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin });
    await until(() => { expect(asked()).toHaveLength(2); });
    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin });

    let ended = false;
    const waiting = language.problemsCaughtUp().then(() => { ended = true; });
    answerFirst([{ plugin: PLUGIN, problems: [] }]);
    await until(() => { expect(asked()).toHaveLength(3); });
    expect(ended).toBe(false);
    answerSecond([{ plugin: PLUGIN, problems: [problem()] }]);
    await waiting;

    expect([...host.problems('modbench-source').keys()]).toEqual([FILE]);
  });

  it('shows mEdit\'s answer at subscribe, and asks again on a save before any load-order-status', async () => {
    const { client, problems } = feed(sourceFolders, [{ plugin: PLUGIN, problems: [problem()] }]);
    expect((await problems()).size).toBe(1);

    client.setQueryAnswer('getPluginProblems', [{ plugin: PLUGIN, problems: [] }]);
    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin }, [REFERRER]);

    expect((await problems()).size).toBe(0);
  });

  it('asks only for the records a notification names', async () => {
    const { client, problems, asked } = feed(sourceFolders, [{ plugin: PLUGIN, problems: [] }]);
    await problems();

    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin }, [REFERRER]);
    await problems();

    expect(asked().map((args) => args[2])).toEqual([undefined, [REFERRER]]);
  });

  it('says nothing when mEdit cannot answer at subscribe, and asks nothing on a save until the record index is ready', async () => {
    const refused = Promise.reject(new Error('mEdit is down.'));
    const { client, reporter, answered, asked } = feed(sourceFolders, refused);
    await refused.catch(() => undefined);
    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin }, [REFERRER]);

    await answered([]);

    expect(asked()).toHaveLength(2);
    expect(reporter.shownFailures).toEqual([]);
  });

  it('asks nothing on a save when the record index began to be late while the ask at subscribe was in flight', async () => {
    let answer!: (problems: PluginProblems[]) => void;
    const { client, problems, answered, asked } = feed(sourceFolders, new Promise<PluginProblems[]>((resolve) => { answer = resolve; }));
    late(client);
    answer([]);
    await problems();
    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin }, [REFERRER]);

    await answered([]);

    expect(asked()).toHaveLength(2);
  });

  it('holds the records changed while it may be late, and asks of those records of each plugin once it is not', async () => {
    const other = { name: 'Other.esp', origin: 'OtherMod' };
    const { client, problems, asked } = feed();
    await problems();
    const end = late(client);
    [{ plugin: PLUGIN, keys: ['1'] }, { plugin: PLUGIN, keys: ['2'] }, { plugin: other, keys: ['3'] }, { plugin: other }].forEach((change) => { client.change([change]); });
    expect(asked()).toHaveLength(1);

    end();
    await until(() => { expect(asked()).toHaveLength(3); });

    expect(asked().slice(1).map((args) => [args[0], args[2]])).toEqual([[PLUGIN, ['1', '2']], [other, undefined]]);
  });

  it('asks nothing when it stops being late with nothing held', async () => {
    const { client, problems, asked } = feed();
    await problems();
    const end = late(client);

    end();
    reconciledAgain(client);
    await problems();

    expect(asked().map((args) => args[0])).toEqual([undefined, undefined]);
  });

  it('asks again for only the plugin a notification names, and keeps the problems of the others', async () => {
    const other = { name: 'Other.esp', origin: 'OtherMod' };
    const { answered, asked } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }, { plugin: other, problems: [problem({ sourceRelativePath: 'Other.esp/Npc.json' })] }]);

    const shown = await answered([{ plugin: PLUGIN, problems: [] }], [{ plugin: { name: PLUGIN.name, origin: PLUGIN.origin }, keys: [REFERRER] }]);

    expect([[...shown.keys()], asked().map((args) => args.slice(0, 1)).at(-1)]).toEqual([['/source/OtherMod/Other.esp/Npc.json'], [PLUGIN]]);
  });

  it('publishes only the files whose problems changed, and nothing again when mEdit answers a plugin as it was', async () => {
    const other = { name: 'Other.esp', origin: 'OtherMod' };
    const { answered } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }, { plugin: other, problems: [problem({ sourceRelativePath: 'Other.esp/Npc.json' })] }]);
    host.published.length = 0;

    await answered([{ plugin: PLUGIN, problems: [problem()] }, { plugin: other, problems: [] }]);
    await answered([{ plugin: PLUGIN, problems: [problem()] }], [{ plugin: PLUGIN }]);

    expect(host.published).toEqual(['/source/OtherMod/Other.esp/Npc.json']);
  });

  it('drops the problems of a plugin that a notification names and mEdit answers no entry for', async () => {
    const { answered } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    const shown = await answered([], [{ plugin: { name: PLUGIN.name, origin: PLUGIN.origin } }]);

    expect([...shown]).toEqual([]);
  });

  it('asks for every plugin when the load order settles', async () => {
    const { answered, asked } = feed();
    await answered([]);

    expect(asked().map((args) => args.slice(0, 1)).at(-1)).toEqual([undefined]);
  });

  it('keeps one ask in flight and at most one pending, however many notifications arrive meanwhile', async () => {
    const { client, problems, asked } = feed(sourceFolders, [{ plugin: PLUGIN, problems: [] }]);
    await problems();
    let answerFirst!: (answer: PluginProblems[]) => void;
    client.setQueryAnswerOnce('getPluginProblems', new Promise<PluginProblems[]>((resolve) => { answerFirst = resolve; }));
    const named = (sequence: number) => { client.hearSequence(sequence); client.change([{ plugin: { name: PLUGIN.name, origin: PLUGIN.origin }, keys: [REFERRER] }]); };
    named(1);
    await until(() => { expect(asked()).toHaveLength(2); });

    [2, 3, 4, 5].forEach(named);
    answerFirst([]);
    await problems();

    expect(asked()).toHaveLength(3);
  });

  it('adds no line for a failure mEdit answers, however its text changes, and keeps the language status current', async () => {
    const { answered, reporter, status } = feed();
    const failed = (failure: string): PluginProblems[] => [{ plugin: PLUGIN, problems: [], failure, failureKind: 'LaterRead' }];

    await answered(failed('Unexpected end at 1.'));
    await answered(failed('Unexpected end at 2.'));
    await answered([{ plugin: PLUGIN, problems: [] }]);
    await answered(failed('Unexpected end at 3.'));

    expect(reporter.shownFailures).toEqual([]);
    expect(status()).toBe('Showing the last good read: "Refers.esp" (ReferringMod): Unexpected end at 3.');
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
    const { client, answered, reporter, problems, asked } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);
    client.setQueryFailureOnce('getPluginProblems', { failed: 'timed-out' });
    client.setQueryFailureOnce('getPluginProblems', { failed: 'timed-out' });

    reconciledAgain(client);
    await until(() => { expect(asked()).toHaveLength(2); });
    reconciledAgain(client);
    await until(() => { expect(asked()).toHaveLength(3); });

    expect([...(await problems()).keys()]).toEqual([FILE]);
    expect(reporter.shownFailures).toEqual([
      { severity: 'warning', message: 'The Problems panel shows mEdit\'s last answer.', detail: 'mEdit did not answer in time.' },
    ]);
  });

  it('says in the language status that it shows the last good read, and why, until the next good answer clears it', async () => {
    const { client, answered, status } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);
    client.setQueryFailureOnce('getPluginProblems', { failed: 'timed-out' });
    reconciledAgain(client);
    await until(() => { expect(status()).toBe('Showing the last good read: mEdit did not answer in time.'); });

    await answered([{ plugin: PLUGIN, problems: [problem()] }]);

    expect(status()).toBeUndefined();
  });

  it('asks again after a delay of an ask that failed, with no event between, and publishes its answer', async () => {
    const { client, answered, status } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);
    vi.useFakeTimers();
    client.setQueryFailureOnce('getPluginProblems', { failed: 'timed-out' });
    reconciledAgain(client);
    await until(() => { expect(status()).toBe('Showing the last good read: mEdit did not answer in time.'); });
    client.setQueryAnswer('getPluginProblems', []);

    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);

    expect([host.problems('modbench-source'), status()]).toEqual([new Map(), undefined]);
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

    expect([...shown.keys()].sort()).toEqual(['/source/OtherMod/Other.esp/Npc.json', FILE]);
    expect(status()).toBe(`Showing the last good read: "Refers.esp" (ReferringMod): ${why}`);
  });

  it('drops the kept problems of a plugin once mEdit places it again', async () => {
    const { answered, status } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);
    await answered([{ plugin: PLUGIN, problems: [], failure: 'unplaced' }]);

    const shown = await answered([{ plugin: PLUGIN, problems: [] }]);

    expect([...shown]).toEqual([]);
    expect(status()).toBeUndefined();
  });

  it('names every unplaced plugin in one language status line', async () => {
    const other = { name: 'Other.esp', origin: 'OtherMod' };
    const { answered, status } = feed();

    await answered([{ plugin: PLUGIN, problems: [], failure: 'one' }, { plugin: other, problems: [], failure: 'two' }]);

    expect(status()).toBe('Showing the last good read: "Refers.esp" (ReferringMod): one; "Other.esp" (OtherMod): two');
  });

  describe('for a plugin mEdit cannot place', () => {
    const stop = (message: string) => problem({ formKey: null, targetFormKey: null, fieldPath: null, message });
    const unplaced = (...problems: PluginProblems['problems']): PluginProblems[] => [{ plugin: PLUGIN, problems, failure: 'unplaced' }];
    const messagesOn = (shown: Shown) => shown.get(FILE)?.map(({ message }) => message);

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

describe('the links of plugin source, when mEdit cannot take the unsaved plugin source', () => {
  const CONNECTION_RESET = { refused: true as const, message: 'mEdit could not take the unsaved plugin source — connection reset' };
  const lastRead = (why: string) => `Showing the last good read: ${why}`;

  it('says so in the language status, with one line in the Output for a reason told again', () => {
    const { client, reporter, status } = feed();

    client.settleHandOver(CONNECTION_RESET);
    client.settleHandOver(CONNECTION_RESET);

    expect(status()).toBe(lastRead(CONNECTION_RESET.message));
    expect(reporter.shownFailures).toEqual([
      { severity: 'warning', message: 'The Problems panel shows what mEdit last took of the unsaved plugin source.', detail: CONNECTION_RESET.message },
    ]);
  });

  it('clears the language status once the next hand-over lands', () => {
    const { client, status } = feed();
    client.settleHandOver(CONNECTION_RESET);

    client.settleHandOver(undefined);

    expect(status()).toBeUndefined();
  });

  it('gives the line alone, so a read of a record can carry it, and clears it with the next hand-over', () => {
    const { client, language } = feed();

    client.settleHandOver(CONNECTION_RESET);
    const whileRefused = language.unsavedSourceMessages();
    client.settleHandOver(undefined);

    expect([whileRefused, language.unsavedSourceMessages()]).toEqual([[lastRead(CONNECTION_RESET.message)], []]);
  });

  it('gives no line for an ask of the Problems panel that failed', async () => {
    const { client, status, language, answered } = feed();
    await answered([{ plugin: PLUGIN, problems: [problem()] }]);
    client.setQueryFailureOnce('getPluginProblems', { failed: 'timed-out' });
    reconciledAgain(client);
    await until(() => { expect(status()).toContain('mEdit did not answer in time.'); });

    expect(language.unsavedSourceMessages()).toEqual([]);
  });
});

describe('the links and the paths of plugin source, together in the Problems panel', () => {
  const PATHS = { plugin: PLUGIN, paths: [{ formKey: REFERRER, fieldPath: 'Model', sourceRelativePath: 'Refers.esp/Npc.json', dataPath: 'Meshes/Gone.nif' }], scripts: [], unread: [] };
  const PATH_PROBLEM = '"Meshes/Gone.nif" names no file the game gets or ReferringMod holds.';
  const both = () => sourceLanguageOver({ arrange: (client) => {
    client.setQueryAnswer('getPluginProblems', [{ plugin: PLUGIN, problems: [problem()] }]);
    client.setQueryAnswer('getPluginFilePaths', [PATHS]);
    host.files.set(FILE, '{}');
  } });

  it('puts both feeds\' problems on one file', async () => {
    const { problems } = both();

    expect((await problems()).get(FILE)?.map(({ message }) => message).sort()).toEqual([PATH_PROBLEM, problem().message]);
  });

  it('keeps the other feed\'s problems when one feed clears', async () => {
    const { client, problems } = both();
    await problems();
    client.setQueryAnswer('getPluginProblems', [{ plugin: PLUGIN, problems: [] }]);

    reconciledAgain(client);

    expect((await problems()).get(FILE)?.map(({ message }) => message)).toEqual([PATH_PROBLEM]);
  });
});
