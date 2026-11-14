import { describe, expect, it, vi } from 'vitest';
import { Uri } from '../../test/vscodeMock';

interface Doc { uri: { scheme: string; fsPath: string }; getText(): string }
const world = vi.hoisted(() => ({
  documents: [] as unknown[],
  shown: new Map<string, unknown[]>(),
  onChange: undefined as undefined | ((event: { document: unknown }) => void),
}));
vi.mock('vscode', () => ({
  Uri,
  Range: class { constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) {} },
  DiagnosticSeverity: { Warning: 1 },
  Diagnostic: class { source?: string; constructor(readonly range: unknown, readonly message: string, readonly severity: number) {} },
  Disposable: { from: (...all: { dispose(): unknown }[]) => ({ dispose: () => { for (const each of all) each.dispose(); } }) },
  languages: {
    createDiagnosticCollection: () => ({
      set: (uri: { fsPath: string }, diagnostics: unknown[]) => { world.shown.set(uri.fsPath, diagnostics); },
      delete: (uri: { fsPath: string }) => { world.shown.delete(uri.fsPath); },
      dispose: () => undefined,
    }),
  },
  workspace: {
    get textDocuments() { return world.documents; },
    onDidOpenTextDocument: () => ({ dispose: () => undefined }),
    onDidChangeTextDocument: (listener: (event: { document: unknown }) => void) => { world.onChange = listener; return { dispose: () => undefined }; },
    onDidCloseTextDocument: () => ({ dispose: () => undefined }),
  },
}));

import { registerNamesNothing } from '../namesNothing';
import type { ScriptSymbol } from '../../symbolNames/symbolNames';
import { fakeKind, fakeKinds } from './fakeKinds';
import { recordingReporter } from '../../test/surfacingDoubles';

const FILE = '/instance/source/Mod/plugin-source/Mod.esp/Quest.json';
const CLOSED = '/instance/source/Other/plugin-source/Other.esp/Npc.json';
const document = (text: string, path = FILE, scheme = 'file'): Doc => ({ uri: { scheme, fsPath: path }, getText: () => text });

const nothing = (start: number, name: string) => ({ start, end: start + name.length, name, why: `Nothing holds ${name}.` });
const judging = <Symbol>(...names: ReturnType<typeof nothing>[]) => fakeKind<Symbol>({ namesNothingIn: () => Promise.resolve(names) });
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function start(kinds: ReturnType<typeof fakeKinds>, files: Record<string, string> = {}) {
  world.shown.clear();
  const reporter = recordingReporter();
  let changed = (): void => undefined;
  registerNamesNothing({
    kinds, reporter, readText: (path) => (path in files ? Promise.resolve(files[path] ?? '') : Promise.reject(new Error(`no ${path}`))),
    onChanged: (listener) => { changed = listener; return { dispose: () => undefined }; },
  });
  return { reporter, changed: () => changed() };
}

describe('the problem a name that names nothing raises (symbols.md, The features, story 8)', () => {
  it('sits on the name\'s span, saying which name and why, once for each open file document', async () => {
    world.documents = [document('xxxxxxxx'), document('y', '/untitled', 'untitled')];
    start(fakeKinds({ script: judging(nothing(2, 'Gone')) }));
    await settle();

    expect([...world.shown.values()].flat()).toEqual([expect.objectContaining({
      message: 'Gone names nothing. Nothing holds Gone.', range: { startLine: 0, startCharacter: 2, endLine: 0, endCharacter: 6 },
    })]);
  });

  it('gathers each kind\'s in text order, and asks nothing of a kind that judges none', async () => {
    world.documents = [document('x')];
    start(fakeKinds({ plugin: judging(nothing(30, 'B.esp')), script: judging(nothing(5, 'Gone')) }));
    await settle();

    expect(world.shown.get(FILE)).toEqual([
      expect.objectContaining({ message: 'Gone names nothing. Nothing holds Gone.' }),
      expect.objectContaining({ message: 'B.esp names nothing. Nothing holds B.esp.' }),
    ]);
  });

  it('judges a file no document holds from its text, when a kind says the file holds one', async () => {
    world.documents = [];
    start(fakeKinds({ script: fakeKind<ScriptSymbol>({ filesNamingNothing: () => Promise.resolve([CLOSED]), namesNothingIn: ({ getText }) => Promise.resolve(getText() === 'closed text' ? [nothing(7, 'Gone')] : []) }) }), { [CLOSED]: 'closed text' });
    await settle();

    expect(world.shown.get(CLOSED)).toEqual([expect.objectContaining({ message: 'Gone names nothing. Nothing holds Gone.' })]);
  });

  it('judges an open file by the text it holds, not by the box\'s ask of the file', async () => {
    world.documents = [document('unsaved text', CLOSED)];
    start(fakeKinds({ script: fakeKind<ScriptSymbol>({ filesNamingNothing: () => Promise.resolve([CLOSED]), namesNothingIn: ({ getText }) => Promise.resolve(getText() === 'unsaved text' ? [] : [nothing(0, 'Gone')]) }) }), { [CLOSED]: 'saved text' });
    await settle();

    expect(world.shown.get(CLOSED)).toEqual([]);
  });

  it('asks each box once for all its files, however many files hold a name', async () => {
    world.documents = [];
    const asked = vi.fn(() => Promise.resolve([CLOSED, FILE]));
    start(fakeKinds({ script: fakeKind<ScriptSymbol>({ filesNamingNothing: asked }) }), { [CLOSED]: '', [FILE]: '' });
    await settle();

    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('clears a file no box says holds one any more, once the instance changes', async () => {
    world.documents = [];
    let holding = [CLOSED];
    const { changed } = start(fakeKinds({ script: fakeKind<ScriptSymbol>({ filesNamingNothing: () => Promise.resolve(holding), namesNothingIn: () => Promise.resolve([nothing(0, 'Gone')]) }) }), { [CLOSED]: 'text' });
    await settle();
    holding = [];
    changed();
    await settle();

    expect(world.shown.has(CLOSED)).toBe(false);
  });

  it('judges an open document again as it changes', async () => {
    let held = [nothing(0, 'Gone')];
    const doc = document('x');
    world.documents = [doc];
    start(fakeKinds({ script: fakeKind<ScriptSymbol>({ namesNothingIn: () => Promise.resolve(held) }) }));
    await settle();
    held = [];
    world.onChange?.({ document: doc });
    await settle();

    expect(world.shown.get(FILE)).toEqual([]);
  });

  it('keeps the last problems where a box cannot answer, and says so once', async () => {
    world.documents = [document('x')];
    const { reporter, changed } = start(fakeKinds({ script: fakeKind<ScriptSymbol>({ namesNothingIn: () => Promise.reject(new Error('mEdit is down')) }) }));
    await settle();
    changed();
    await settle();

    expect(reporter.shownFailures).toEqual([{ severity: 'warning', message: 'The Problems panel shows the last names that name nothing.', detail: 'mEdit is down' }]);
  });
});
