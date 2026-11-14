import { describe, expect, it, vi } from 'vitest';

interface Doc { uri: { scheme: string; fsPath: string }; getText(): string; positionAt(offset: number): { line: number; character: number } }
const world = vi.hoisted(() => ({
  documents: [] as unknown[],
  shown: new Map<string, unknown[]>(),
  onChange: undefined as undefined | ((event: { document: unknown }) => void),
}));
vi.mock('vscode', () => ({
  Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
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
const document = (text: string, scheme = 'file'): Doc => ({
  uri: { scheme, fsPath: FILE }, getText: () => text, positionAt: (offset) => ({ line: 0, character: offset }),
});

const nothing = (start: number, name: string) => ({ start, end: start + name.length, name, why: `Nothing holds ${name}.` });
const judging = <Symbol>(...names: ReturnType<typeof nothing>[]) => fakeKind<Symbol>({ namesNothingIn: () => Promise.resolve(names) });

describe('the problem a name that names nothing raises (symbols.md, The features, story 8)', () => {
  const start = (kinds: ReturnType<typeof fakeKinds>, reporter = recordingReporter()) => {
    let instanceChanged = (): void => undefined;
    registerNamesNothing({ kinds, reporter, onInstanceChanged: (listener) => { instanceChanged = listener; return { dispose: () => undefined }; } });
    return { reporter, instanceChanged: () => instanceChanged() };
  };
  const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

  it('sits on the name\'s span, saying which name and why, once for each open file document', async () => {
    world.documents = [document('x'), document('y', 'untitled')];
    start(fakeKinds({ script: judging(nothing(2, 'Gone')) }));
    await settle();

    expect([...world.shown.values()].flat()).toEqual([expect.objectContaining({
      message: 'Gone names nothing. Nothing holds Gone.', range: { start: { line: 0, character: 2 }, end: { line: 0, character: 6 } },
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

  it('is judged again when the instance changes, and clears when the name resolves', async () => {
    let held = [nothing(0, 'Gone')];
    world.documents = [document('x')];
    const { instanceChanged } = start(fakeKinds({ script: fakeKind<ScriptSymbol>({ namesNothingIn: () => Promise.resolve(held) }) }));
    await settle();
    held = [];
    instanceChanged();
    await settle();

    expect(world.shown.get(FILE)).toEqual([]);
  });

  it('keeps the last problems where a kind cannot answer, and says so once', async () => {
    world.documents = [document('x')];
    const { reporter, instanceChanged } = start(fakeKinds({ script: fakeKind<ScriptSymbol>({ namesNothingIn: () => Promise.reject(new Error('mEdit is down')) }) }));
    await settle();
    instanceChanged();
    await settle();

    expect(reporter.shownFailures).toEqual([{ severity: 'warning', message: 'The Problems panel shows the last names that name nothing.', detail: 'mEdit is down' }]);
  });
});
