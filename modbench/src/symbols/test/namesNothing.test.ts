import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { document, host, type FakeDocument } from './vscodeHost';
import { instanceHolding, symbolsOver } from './symbolsOver';
import { mEditNames, spelledName } from './mEditNames';
import type { DocumentName, MEditClient, PluginAddress, PluginFilePaths } from '../../client';
import type { InstanceValue } from '../../instanceLoader/instance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { settled as until } from '../../test/eventually';
import { REQUESTS_AT_ONCE } from '../../ports/bounded';
import { localFailure, type ReadFailed } from '../../wire/readFailed';
import { changeNamesPlugin } from '../../client/test/says';

const MOD = { name: 'Mod.esp', origin: 'Mod' };
const OTHER = { name: 'Other.esp', origin: 'Other' };
const fileOf = ({ name, origin }: PluginAddress, file: string) => `/instance/source/${origin}/plugin-source/${name}/${file}`;
const SOURCE = fileOf(MOD, 'Quest.json');
const CLOSED = fileOf(OTHER, 'Npc.json');
const TEXT = '{ "Scripts": [ "Lost", "Gone" ] }';
const NAMES_NOTHING = 'modbench-names';
const NOT_READY = { failed: 'refused', refusal: 'the record index is not ready' } as const;
const why = (name: string) => `${name} names nothing. No mod, Overwrite, Data folder file or archive holds ${name}.`;
const BOTH = [why('Lost'), why('Gone')];
const scriptsIn = (text: string): DocumentName[] => ['Gone', 'Lost'].filter((name) => text.includes(`"${name}"`)).map((name) => spelledName('Script', text, name));

type Standing = Pick<InstanceValue, 'dataFolderFiles' | 'gameFolder' | 'gameFolderInWorkspace' | 'archiveContents'>;
const JUDGING: Standing = {
  dataFolderFiles: { kind: 'listed', files: new Map() }, gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' },
  gameFolderInWorkspace: true, archiveContents: new Map(),
};

const namedIn = (plugin: PluginAddress, files: readonly string[], over: Partial<PluginFilePaths> = {}): PluginFilePaths => ({
  plugin, paths: [], unread: [], ...over,
  scripts: files.map((file) => ({ formKey: `000801:${plugin.name}`, fieldPath: 'Name', sourceRelativePath: `${plugin.name}/${file}`, name: 'Gone' })),
});

type Names = Pick<MEditClient, 'getPluginSourceNames'>;
interface Judging { named?: PluginFilePaths[]; firstAsk?: ReadFailed; held?: FakeDocument[]; saved?: readonly string[]; names?: Names }

function judging({ named = [], firstAsk, held = [], saved = [], names = mEditNames(scriptsIn) }: Judging = {}) {
  const instance = instanceHolding(instanceValueFixture({ papyrusScripts: [], ...JUDGING }));
  const savedText = vi.fn((path: string) => Promise.resolve(saved.includes(path) ? TEXT : undefined));
  const made = symbolsOver({
    instance, names, savedText,
    sourceFiles: (origin) => (origin === 'Overwrite' ? undefined : { file: (relativePath) => `/instance/source/${origin}/plugin-source/${relativePath}` }),
    arrange: (client) => {
      if (firstAsk !== undefined) client.setQueryFailureOnce('getPluginFilePaths', firstAsk);
      client.setQueryAnswer('getPluginFilePaths', named);
      host.holds(held);
    },
  });
  const asked = () => made.client.calls.filter(({ method }) => method === 'getPluginFilePaths').map(({ args }) => args);
  return { ...made, instance, savedText, asked };
}

const shown = (file: string) => host.problems(NAMES_NOTHING).get(file)?.map(({ message }) => message);
const WHOLE = [undefined, undefined, undefined];
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const MANY = Array.from({ length: REQUESTS_AT_ONCE * 2 }, (_, each) => `${each}.json`);

function heldNames() {
  const asked: string[] = [];
  const pending: ((names: DocumentName[]) => void)[] = [];
  let inFlight = 0;
  let mostAtOnce = 0;
  const names: Names = {
    getPluginSourceNames: (_text, path) => {
      asked.push(path ?? '');
      inFlight += 1;
      mostAtOnce = Math.max(mostAtOnce, inFlight);
      return new Promise((resolve) => { pending.push((answer) => { inFlight -= 1; resolve(answer); }); });
    },
  };
  return { names, asked, release: (answer: DocumentName[] = [], at = 0) => { pending.splice(at, 1)[0]?.(answer); }, mostAtOnce: () => mostAtOnce };
}

describe('the problem a name that names nothing raises (symbols.md, The features, story 8)', () => {
  it('sits on the name\'s span, saying which name and why, once for each open file document', async () => {
    const reversed = mEditNames((text) => scriptsIn(text).reverse());
    judging({ held: [document(SOURCE, TEXT), document('/untitled', TEXT, { scheme: 'untitled' })], names: reversed });

    const span = (name: string) => ({ start: { line: 0, character: TEXT.indexOf(name) }, end: { line: 0, character: TEXT.indexOf(name) + name.length } });
    await until(() => {
      expect(host.problems(NAMES_NOTHING)).toEqual(new Map([[SOURCE, ['Lost', 'Gone'].map((name) => ({ message: why(name), ...span(name) }))]]));
    });
  });

  it('judges an open file by the text it holds, never by the file on disk', async () => {
    const { savedText } = judging({ named: [namedIn(OTHER, ['Npc.json'])], held: [document(CLOSED, '{}')], saved: [CLOSED] });

    await until(() => { expect(shown(CLOSED)).toEqual([]); });
    expect(savedText.mock.calls).toEqual([]);
  });

  it.each([
    ['closed files', { named: [namedIn(OTHER, MANY)], saved: MANY.map((file) => fileOf(OTHER, file)) }],
    ['open documents', { held: MANY.map((file) => document(fileOf(OTHER, file), TEXT)) }],
  ])('judges no more %s at once than its limit, however many name a script', async (_case, over) => {
    const held = heldNames();
    judging({ ...over, names: held.names });
    await until(() => { expect(held.asked).toHaveLength(REQUESTS_AT_ONCE); });

    held.release();

    await until(() => { expect(held.asked).toHaveLength(REQUESTS_AT_ONCE + 1); });
    expect(held.mostAtOnce()).toBe(REQUESTS_AT_ONCE);
  });

  it('judges the document being edited before the closed files that wait for a place', async () => {
    const held = heldNames();
    judging({ named: [namedIn(OTHER, MANY)], saved: MANY.map((file) => fileOf(OTHER, file)), names: held.names });
    await until(() => { expect(held.asked).toHaveLength(REQUESTS_AT_ONCE); });

    host.change(document(SOURCE, TEXT));
    await settle();
    held.release();

    await until(() => { expect(held.asked).toHaveLength(REQUESTS_AT_ONCE + 1); });
    expect(held.asked.at(-1)).toBe(SOURCE);
  });

  it('asks mEdit once for every plugin, however many files name a script, then of the records a change names, and of all once the instance changes', async () => {
    const made = judging({ named: [namedIn(MOD, ['Quest.json']), namedIn(OTHER, ['Npc.json'])], saved: [SOURCE, CLOSED] });
    await until(() => { expect([shown(SOURCE), shown(CLOSED)]).toEqual([BOTH, BOTH]); });

    changeNamesPlugin(made.client, OTHER, ['000800:Other.esp']);
    await until(() => { expect(made.asked()).toHaveLength(2); });
    made.instance.land({ ...made.instance.value, papyrusScripts: [] });

    await until(() => { expect(made.asked()).toEqual([WHOLE, [OTHER, undefined, ['000800:Other.esp']], WHOLE]); });
  });

  it('leaves out the files of a plugin no mod holds', async () => {
    const made = judging({ named: [namedIn({ name: 'Over.esp', origin: 'Overwrite' }, ['Npc.json']), namedIn(MOD, ['Quest.json'])], saved: [SOURCE] });

    await until(() => { expect(made.savedText.mock.calls).toEqual([[SOURCE]]); });
  });

  describe('when a change leaves what is judged as it was', () => {
    const judgedAfter = async (change: (made: ReturnType<typeof judging>) => void) => {
      const made = judging({ named: [namedIn(OTHER, ['Npc.json'])], saved: [CLOSED] });
      await until(() => { expect(made.savedText).toHaveBeenCalledTimes(1); });
      change(made);
      changeNamesPlugin(made.client, OTHER);
      await until(() => { expect(made.asked()).toHaveLength(2); });
      await settle();
      return made.savedText.mock.calls.length;
    };

    it('judges nothing again when every kind answers the files it answered and the instance value is the same', async () => {
      expect(await judgedAfter(() => undefined)).toBe(1);
    });

    it('judges again when the instance holds another value', async () => {
      expect(await judgedAfter((made) => { made.instance.value = { ...made.instance.value }; })).toBe(2);
    });

    it('judges again when a kind answers its files as another list', async () => {
      expect(await judgedAfter((made) => { made.client.setQueryAnswer('getPluginFilePaths', [namedIn(OTHER, ['Npc.json'])]); })).toBe(2);
    });

    it('judges again when a document closes, though nothing else changed, asking mEdit nothing', async () => {
      const made = judging({ named: [namedIn(OTHER, ['Npc.json'])], saved: [CLOSED] });
      await until(() => { expect(made.savedText).toHaveBeenCalledTimes(1); });

      host.close(document('/elsewhere.json', ''));

      await until(() => { expect(made.savedText).toHaveBeenCalledTimes(2); });
      expect(made.asked()).toEqual([WHOLE]);
    });
  });

  it('clears a file no kind says holds one any more', async () => {
    const made = judging({ named: [namedIn(OTHER, ['Npc.json'])], saved: [CLOSED] });
    await until(() => { expect(shown(CLOSED)).toEqual(BOTH); });
    made.client.setQueryAnswer('getPluginFilePaths', []);

    changeNamesPlugin(made.client, OTHER);

    await until(() => { expect(host.problems(NAMES_NOTHING).has(CLOSED)).toBe(false); });
  });

  it('keeps what it holds of the plugins a change does not name', async () => {
    const made = judging({ named: [namedIn(MOD, ['Quest.json'])], saved: [SOURCE, CLOSED] });
    await until(() => { expect(shown(SOURCE)).toEqual(BOTH); });
    made.client.setQueryAnswer('getPluginFilePaths', [namedIn(OTHER, ['Npc.json'])]);

    changeNamesPlugin(made.client, OTHER);

    await until(() => { expect([shown(SOURCE), shown(CLOSED)]).toEqual([BOTH, BOTH]); });
  });

  it('drops a plugin that left the load order, and keeps what a plugin whose answer failed last held, saying why once', async () => {
    const made = judging({ named: [namedIn(MOD, ['Quest.json']), namedIn(OTHER, ['Npc.json'])], saved: [SOURCE, CLOSED] });
    await until(() => { expect(host.problems(NAMES_NOTHING).size).toBe(2); });
    made.client.setQueryAnswer('getPluginFilePaths', [namedIn(MOD, ['Quest.json'], { failure: 'its source is unreadable' })]);

    made.client.change(undefined);
    await until(() => { expect([...host.problems(NAMES_NOTHING).keys()]).toEqual([SOURCE]); });
    made.client.change(undefined);
    await until(() => { expect(made.asked()).toHaveLength(3); });
    await settle();

    expect(made.reporter.shownFailures).toEqual([{ severity: 'warning', message: 'The Problems panel does not check every script plugin source names.', detail: '"Mod.esp" (Mod): its source is unreadable' }]);
  });

  it('says the copies it could not read, and keeps the scripts that read', async () => {
    const made = judging({ named: [namedIn(MOD, ['Quest.json'], { unread: ['000801:Mod.esp: no schema'] })], saved: [SOURCE] });

    await until(() => { expect(shown(SOURCE)).toEqual(BOTH); });
    expect(made.reporter.shownFailures.map(({ detail }) => detail)).toEqual(['"Mod.esp" (Mod): 000801:Mod.esp: no schema']);
  });

  it.each([
    ['cannot answer', localFailure('mEdit is down'), ['mEdit is down']],
    ['has nothing to say yet', NOT_READY, []],
  ])('keeps the problems it showed of closed files where mEdit %s, and says so once', async (_case, failure, told) => {
    const made = judging({ named: [namedIn(OTHER, ['Npc.json'])], saved: [CLOSED] });
    await until(() => { expect(shown(CLOSED)).toEqual(BOTH); });
    made.client.setQueryFailure('getPluginFilePaths', failure);

    made.client.change(undefined);
    await until(() => { expect(made.asked()).toHaveLength(2); });
    made.client.change(undefined);
    await until(() => { expect(made.asked()).toHaveLength(3); });
    await settle();

    expect([shown(CLOSED), made.reporter.shownFailures.map(({ detail }) => detail)]).toEqual([BOTH, told]);
  });

  it('keeps the problems it showed of an open document whose names mEdit cannot answer, and says so once', async () => {
    let answer: DocumentName[] | ReadFailed = scriptsIn(TEXT);
    const doc = document(SOURCE, TEXT);
    const made = judging({ held: [doc], names: { getPluginSourceNames: () => Promise.resolve(answer) } });
    await until(() => { expect(shown(SOURCE)).toEqual(BOTH); });
    answer = localFailure('mEdit is down');

    host.change(doc);
    await until(() => { expect(made.reporter.shownFailures).toHaveLength(1); });
    host.change(doc);
    await settle();

    expect([shown(SOURCE), made.reporter.shownFailures]).toEqual([
      BOTH, [{ severity: 'warning', message: 'The Problems panel shows the last names that name nothing.', detail: 'mEdit is down' }],
    ]);
  });

  it('keeps the problems of an open document while a kind cannot judge yet', async () => {
    const doc = document(SOURCE, TEXT);
    const made = judging({ held: [doc] });
    await until(() => { expect(shown(SOURCE)).toEqual(BOTH); });

    made.instance.land({ ...made.instance.value, dataFolderFiles: { kind: 'unresolved' } });
    host.change(doc);
    await settle();

    expect(shown(SOURCE)).toEqual(BOTH);
  });

  it.each([
    ['fails', localFailure('mEdit is down')],
    ['cannot answer yet', NOT_READY],
  ])('asks for every plugin again after a whole-set ask that %s, even when one plugin\'s files changed', async (_case, failure) => {
    const made = judging({ firstAsk: failure });
    await until(() => { expect(made.asked()).toHaveLength(1); });

    changeNamesPlugin(made.client, OTHER);
    await until(() => { expect(made.asked()).toHaveLength(2); });
    changeNamesPlugin(made.client, OTHER);

    await until(() => { expect(made.asked()).toEqual([WHOLE, WHOLE, [OTHER, undefined, undefined]]); });
  });

  it('judges an open document again as it changes, and drops a judgement that a later one overtook', async () => {
    const held = heldNames();
    const doc = document(SOURCE, TEXT);
    judging({ held: [doc], names: held.names });
    await until(() => { expect(held.asked).toHaveLength(1); });

    host.change(doc);
    await until(() => { expect(held.asked).toHaveLength(2); });
    held.release([], 1);
    held.release(scriptsIn(TEXT));
    await settle();

    expect(shown(SOURCE)).toEqual([]);
  });

  it('reads a file whose document closed from disk, without opening one', async () => {
    const doc = document(SOURCE, TEXT);
    const made = judging({ named: [namedIn(MOD, ['Quest.json'])], held: [doc], saved: [SOURCE] });
    await until(() => { expect(shown(SOURCE)).toEqual(BOTH); });

    host.holds([]);
    host.close(doc);

    await until(() => { expect(made.savedText.mock.calls).toEqual([[SOURCE]]); });
  });
});
