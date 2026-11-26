import { describe, expect, it, vi } from 'vitest';
import { Diagnostic, DiagnosticSeverity, FakeDiagnosticCollection, Range, Uri } from '../../test/vscodeMock';

interface Doc { uri: { scheme: string; fsPath: string }; getText(): string }
const world = vi.hoisted(() => ({
  documents: [] as unknown[],
  handlers: new Map<string, (event: unknown) => void>(),
}));
vi.mock('vscode', () => ({
  Uri, Range, Diagnostic, DiagnosticSeverity,
  Disposable: { from: (...all: { dispose(): unknown }[]) => ({ dispose: () => { for (const each of all) each.dispose(); } }) },
  workspace: {
    get textDocuments() { return world.documents; },
    onDidOpenTextDocument: () => ({ dispose: () => undefined }),
    onDidChangeTextDocument: (listener: (event: unknown) => void) => { world.handlers.set('change', listener); return { dispose: () => undefined }; },
    onDidCloseTextDocument: (listener: (event: unknown) => void) => { world.handlers.set('close', listener); return { dispose: () => undefined }; },
  },
}));

import { registerNamesNothing } from '../namesNothing';
import { bounded, REQUESTS_AT_ONCE } from '../../ports/bounded';
import type { PluginAddress } from '../../client';
import type { PluginRecords } from '../../drivingLib/namedPlugins';
import type { ScriptSymbol } from '../../symbolNames/symbolNames';
import { fakeKind, fakeKinds } from './fakeKinds';
import { recordingReporter } from '../../test/surfacingDoubles';
import { settled } from '../../test/eventually';

const FILE = '/instance/source/Mod/plugin-source/Mod.esp/Quest.json';
const CLOSED = '/instance/source/Other/plugin-source/Other.esp/Npc.json';
const PLUGIN: PluginAddress = { name: 'Other.esp', origin: 'Other' };
const document = (text: string, path = FILE, scheme = 'file'): Doc => ({ uri: { scheme, fsPath: path }, getText: () => text });

const nothing = (start: number, name: string) => ({ start, end: start + name.length, name, why: `Nothing holds ${name}.` });
const judging = <Symbol>(...names: ReturnType<typeof nothing>[]) => fakeKind<Symbol>({ namesNothingIn: () => Promise.resolve(names) });
const script = (over: Parameters<typeof fakeKind<ScriptSymbol>>[0]) => fakeKinds({ script: fakeKind<ScriptSymbol>(over) });
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const messagesOn = (collection: FakeDiagnosticCollection, file: string) => collection.get(Uri.file(file))?.map(({ message }) => message);

function start(kinds: ReturnType<typeof fakeKinds>, saved: Record<string, string> = {}, instance?: { value: object }) {
  const collection = new FakeDiagnosticCollection();
  const reporter = recordingReporter();
  const savedText = vi.fn((path: string) => Promise.resolve(saved[path]));
  let changed: (plugin?: PluginAddress) => void = () => undefined;
  const forgotten: (PluginAddress | undefined)[] = [];
  registerNamesNothing({
    kinds, reporter, savedText, collection, instance,
    asker: { inTurn: bounded(REQUESTS_AT_ONCE), forget: (plugin) => { forgotten.push(plugin); } },
    onChanged: (listener) => { changed = listener; return { dispose: () => undefined }; },
  });
  return { collection, reporter, savedText, forgotten, changed: (plugin?: PluginAddress) => { changed(plugin); } };
}

describe('the problem a name that names nothing raises (symbols.md, The features, story 8)', () => {
  it('sits on the name\'s span, saying which name and why, once for each open file document', async () => {
    world.documents = [document('xxxxxxxx'), document('y', '/untitled', 'untitled')];
    const { collection } = start(fakeKinds({ script: judging(nothing(2, 'Gone')) }));
    await settle();

    expect([...collection].map(([, diagnostics]) => diagnostics.map(({ message, range }) => [message, range.start, range.end]))).toEqual([
      [['Gone names nothing. Nothing holds Gone.', { line: 0, character: 2 }, { line: 0, character: 6 }]],
    ]);
  });

  it('gathers the names of every kind that judges, in text order, and adds none for a kind that judges none', async () => {
    world.documents = [document('x'.repeat(40))];
    const { collection } = start(fakeKinds({ plugin: judging(nothing(30, 'B.esp')), script: judging(nothing(5, 'Gone')) }));
    await settle();

    expect(messagesOn(collection, FILE)).toEqual(['Gone names nothing. Nothing holds Gone.', 'B.esp names nothing. Nothing holds B.esp.']);
  });

  it('judges a file no document holds from its text on disk, when a kind says the file holds one', async () => {
    world.documents = [];
    const { collection } = start(script({
      filesNamingNothing: () => Promise.resolve([CLOSED]),
      namesNothingIn: ({ getText }) => Promise.resolve(getText() === 'closed text' ? [nothing(7, 'Gone')] : []),
    }), { [CLOSED]: 'closed text' });
    await settle();

    expect(messagesOn(collection, CLOSED)).toEqual(['Gone names nothing. Nothing holds Gone.']);
  });

  it('judges an open file by the text it holds, never by the file on disk', async () => {
    world.documents = [document('unsaved text', CLOSED)];
    const { collection, savedText } = start(script({
      filesNamingNothing: () => Promise.resolve([CLOSED]),
      namesNothingIn: ({ getText }) => Promise.resolve(getText() === 'unsaved text' ? [] : [nothing(0, 'Gone')]),
    }), { [CLOSED]: 'saved text' });
    await settle();

    expect([messagesOn(collection, CLOSED), savedText.mock.calls]).toEqual([[], []]);
  });

  it('judges no more closed files at once than its limit, however many files hold a name', async () => {
    world.documents = [];
    const files = Array.from({ length: REQUESTS_AT_ONCE * 3 }, (_, each) => `/closed/${each}.json`);
    let inFlight = 0;
    let mostAtOnce = 0;
    const judgedFiles = vi.fn(async () => {
      inFlight += 1;
      mostAtOnce = Math.max(mostAtOnce, inFlight);
      await settle();
      inFlight -= 1;
      return [];
    });
    start(script({ filesNamingNothing: () => Promise.resolve(files), namesNothingIn: judgedFiles }), Object.fromEntries(files.map((file) => [file, ''])));
    await settled(() => { expect(judgedFiles).toHaveBeenCalledTimes(files.length); });

    expect(mostAtOnce).toBe(REQUESTS_AT_ONCE);
  });

  it('judges no more open documents at once than its limit', async () => {
    const files = Array.from({ length: REQUESTS_AT_ONCE * 3 }, (_, each) => `/open/${each}.json`);
    world.documents = files.map((file) => document('text', file));
    let inFlight = 0;
    let mostAtOnce = 0;
    const judgedFiles = vi.fn(async () => {
      inFlight += 1;
      mostAtOnce = Math.max(mostAtOnce, inFlight);
      await settle();
      inFlight -= 1;
      return [];
    });
    start(script({ namesNothingIn: judgedFiles }));
    await settled(() => { expect(judgedFiles).toHaveBeenCalledTimes(files.length); });

    expect(mostAtOnce).toBe(REQUESTS_AT_ONCE);
  });

  it('has the asker forget all it held when a document closes', async () => {
    world.documents = [];
    const { forgotten } = start(script({ filesNamingNothing: () => Promise.resolve([]) }));
    await settle();

    world.handlers.get('close')?.(document('closed'));

    expect(forgotten).toEqual([undefined]);
  });

  it('judges the document being edited before the closed files that wait for a place', async () => {
    const closed = Array.from({ length: REQUESTS_AT_ONCE * 2 }, (_, each) => `/closed/${each}.json`);
    world.documents = [];
    const order: string[] = [];
    const finish: (() => void)[] = [];
    const judgedFile = vi.fn(({ uri }: { uri: { fsPath: string } }) => {
      order.push(uri.fsPath);
      return new Promise<never[]>((resolve) => { finish.push(() => { resolve([]); }); });
    });
    start(script({ filesNamingNothing: () => Promise.resolve(closed), namesNothingIn: judgedFile }), Object.fromEntries(closed.map((file) => [file, ''])));
    await settled(() => { expect(order).toHaveLength(REQUESTS_AT_ONCE); });

    world.handlers.get('change')?.({ document: document('typed', FILE) });
    await settle();
    finish[0]?.();
    await settled(() => { expect(order).toHaveLength(REQUESTS_AT_ONCE + 1); });

    expect(order.at(-1)).toBe(FILE);
  });

  it('asks each kind once for all its files, however many files hold a name', async () => {
    world.documents = [];
    const asked = vi.fn(() => Promise.resolve([CLOSED, FILE]));
    start(script({ filesNamingNothing: asked }), { [CLOSED]: '', [FILE]: '' });
    await settle();

    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('asks of the one plugin whose source changed, and of all once the instance changes', async () => {
    world.documents = [];
    const asked = vi.fn((_only?: readonly PluginRecords[]) => Promise.resolve([] as string[]));
    const { changed } = start(script({ filesNamingNothing: asked }));
    await settle();
    changed(PLUGIN);
    await settle();
    changed();
    await settle();

    expect(asked.mock.calls).toEqual([[undefined], [[{ plugin: PLUGIN }]], [undefined]]);
  });

  describe('when a change leaves what is judged as it was', () => {
    const judgedAfter = async (change: (instance: { value: object }, files: string[]) => string[] | undefined) => {
      world.documents = [];
      const files = [CLOSED];
      let answer = files;
      const instance = { value: {} };
      const { changed, savedText } = start(script({ filesNamingNothing: () => Promise.resolve(answer), namesNothingIn: () => Promise.resolve([nothing(0, 'Gone')]) }), { [CLOSED]: '' }, instance);
      await settle();
      answer = change(instance, files) ?? files;
      changed(PLUGIN);
      await settle();
      return savedText.mock.calls.length;
    };

    it('judges nothing again when every kind answers the files it answered and the instance value is the same', async () => {
      expect(await judgedAfter(() => undefined)).toBe(1);
    });

    it('judges again when the instance holds another value', async () => {
      expect(await judgedAfter((instance) => { instance.value = {}; return undefined; })).toBe(2);
    });

    it('judges again when a kind answers its files as another list', async () => {
      expect(await judgedAfter((_instance, files) => [...files])).toBe(2);
    });

    it('judges again when a document closes, though nothing else changed', async () => {
      world.documents = [];
      const files = [CLOSED];
      const { savedText } = start(script({ filesNamingNothing: () => Promise.resolve(files), namesNothingIn: () => Promise.resolve([]) }), { [CLOSED]: '' }, { value: {} });
      await settle();

      world.handlers.get('close')?.(document('', CLOSED));
      await settle();

      expect(savedText).toHaveBeenCalledTimes(2);
    });
  });

  it('clears a file no kind says holds one any more', async () => {
    world.documents = [];
    let holding = [CLOSED];
    const { collection, changed } = start(script({
      filesNamingNothing: () => Promise.resolve(holding), namesNothingIn: () => Promise.resolve([nothing(0, 'Gone')]),
    }), { [CLOSED]: 'text' });
    await settle();
    holding = [];
    changed();
    await settle();

    expect(collection.has(Uri.file(CLOSED))).toBe(false);
  });

  it.each([
    ['cannot answer', () => Promise.reject(new Error('mEdit is down')), ['mEdit is down']],
    ['has nothing to say yet', () => Promise.resolve(undefined), []],
  ])('keeps the problems it showed of closed files where a kind %s, and says so once', async (_case, answer, told) => {
    world.documents = [];
    let ask: () => Promise<string[] | undefined> = () => Promise.resolve([CLOSED]);
    const { collection, reporter, changed } = start(script({
      filesNamingNothing: () => ask(), namesNothingIn: () => Promise.resolve([nothing(0, 'Gone')]),
    }), { [CLOSED]: 'text' });
    await settle();
    ask = answer;
    changed();
    await settle();
    changed();
    await settle();

    expect([messagesOn(collection, CLOSED), reporter.shownFailures.map(({ detail }) => detail)]).toEqual([['Gone names nothing. Nothing holds Gone.'], told]);
  });

  it('keeps the problems of an open document while a kind cannot judge yet', async () => {
    let answer: ReturnType<typeof nothing>[] | undefined = [nothing(0, 'Gone')];
    const doc = document('xxxxxxxx');
    world.documents = [doc];
    const { collection, changed } = start(script({ namesNothingIn: () => Promise.resolve(answer) }));
    await settle();
    answer = undefined;
    changed();
    world.handlers.get('change')?.({ document: doc });
    await settle();

    expect(messagesOn(collection, FILE)).toEqual(['Gone names nothing. Nothing holds Gone.']);
  });

  it.each([
    ['fails', () => Promise.reject(new Error('mEdit is down'))],
    ['cannot answer yet', () => Promise.resolve(undefined)],
  ])('asks for every plugin again after a whole-set ask that %s, even when one plugin\'s files changed', async (_case, failing) => {
    world.documents = [];
    let ask: (only?: readonly PluginRecords[]) => Promise<string[] | undefined> = failing;
    const asked = vi.fn((only?: readonly PluginRecords[]) => ask(only));
    const { changed } = start(script({ filesNamingNothing: asked }));
    await settle();
    ask = () => Promise.resolve([]);
    changed(PLUGIN);
    await settle();
    changed(PLUGIN);
    await settle();

    expect(asked.mock.calls).toEqual([[undefined], [undefined], [[{ plugin: PLUGIN }]]]);
  });

  it('judges an open document again as it changes, and drops a judgement that a later one overtook', async () => {
    let release: (names: ReturnType<typeof nothing>[]) => void = () => undefined;
    const slow = new Promise<ReturnType<typeof nothing>[]>((resolve) => { release = resolve; });
    let asked = 0;
    const doc = document('xxxxxxxx');
    world.documents = [doc];
    const { collection } = start(script({ namesNothingIn: () => (asked++ === 0 ? slow : Promise.resolve([])) }));
    await settle();
    world.handlers.get('change')?.({ document: doc });
    await settle();
    release([nothing(0, 'Stale')]);
    await settle();

    expect(messagesOn(collection, FILE)).toEqual([]);
  });

  it('reads a file whose document closed from disk, without opening one', async () => {
    const doc = document('x');
    world.documents = [doc];
    const { savedText } = start(script({ filesNamingNothing: () => Promise.resolve([FILE]) }), { [FILE]: 'saved' });
    await settle();
    world.documents = [];
    world.handlers.get('close')?.(doc);
    await settle();

    expect(savedText.mock.calls).toEqual([[FILE]]);
  });
});
