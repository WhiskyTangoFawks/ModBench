import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, Range, DiagnosticSeverity, FakeDiagnosticCollection, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => {
  class CodeAction {
    diagnostics: unknown[] = [];
    command: unknown;
    constructor(readonly title: string, readonly kind: string) {}
  }
  return { Diagnostic, Range, DiagnosticSeverity, Uri, CodeAction, CodeActionKind: { QuickFix: 'quickfix' } };
});

import { unmanagedProblems } from '../unmanagedProblems';

const at = (path: string) => ({ path, file: `/deployed/${path}` });

const published = (collection: FakeDiagnosticCollection) =>
  [...collection].map(([uri, [problem]]) => ({ path: uri.fsPath, severity: problem?.severity, message: problem?.message }));

function fixesFor(problems: ReturnType<typeof unmanagedProblems>, collection: FakeDiagnosticCollection, file: string) {
  const diagnostics = [...collection].filter(([uri]) => uri.fsPath === file).flatMap(([, held]) => held);
  return problems.quickFixes.provideCodeActions({ uri: { fsPath: file } }, undefined, { diagnostics });
}

describe('the problems on files deploy does not manage', () => {
  it('is one warning on each file, at where it is', () => {
    const collection = new FakeDiagnosticCollection();

    unmanagedProblems(collection).publish([at('Data/MCM/settings.ini'), at('game.exe')], []);

    expect(published(collection).map(({ path, severity, message }) => [path, severity, message])).toEqual([
      ['/deployed/Data/MCM/settings.ini', DiagnosticSeverity.Warning, 'Deploy does not manage this file.'],
      ['/deployed/game.exe', DiagnosticSeverity.Warning, 'Deploy does not manage this file.'],
    ]);
  });

  it('names the file it left out, when the path of a file the game gets holds this file', () => {
    const collection = new FakeDiagnosticCollection();

    unmanagedProblems(collection).publish([at('Data/a.esp')], [{ path: 'Data/a.esp', winner: '/instance/mods/Mod/a.esp' }]);

    expect(published(collection)[0]?.message).toBe('Deploy does not manage this file, and left out /instance/mods/Mod/a.esp, which the game would get at its path.');
  });

  it('replaces the files it held, so a file that is gone has no problem', () => {
    const collection = new FakeDiagnosticCollection();
    const problems = unmanagedProblems(collection);
    problems.publish([at('a.exe'), at('b.exe')], []);

    problems.publish([at('b.exe')], []);

    expect(published(collection).map(({ path }) => path)).toEqual(['/deployed/b.exe']);
  });
});

describe('the quick fix on a file deploy does not manage', () => {
  it('is move to Overwrite, with the file\'s path, on a file a mod file can land at the path of', () => {
    const collection = new FakeDiagnosticCollection();
    const problems = unmanagedProblems(collection);
    problems.publish([at('Data/MCM/settings.ini')], []);

    const [fix] = fixesFor(problems, collection, '/deployed/Data/MCM/settings.ini');

    expect([fix?.title, fix?.kind, fix?.command, fix?.diagnostics?.length]).toEqual([
      'Move to Overwrite', 'quickfix', { command: 'modbench.instance.moveToOverwrite', title: 'Move to Overwrite', arguments: [['Data/MCM/settings.ini']] }, 1,
    ]);
  });

  it('is offered on no file where no mod file can land at its path', () => {
    const collection = new FakeDiagnosticCollection();
    const problems = unmanagedProblems(collection);
    problems.publish([at('Data/.hidden')], []);

    expect(fixesFor(problems, collection, '/deployed/Data/.hidden')).toEqual([]);
  });

  it('is offered on no file once its problem is gone', () => {
    const collection = new FakeDiagnosticCollection();
    const problems = unmanagedProblems(collection);
    problems.publish([at('Data/a.esp')], []);
    const diagnostics = [...collection].flatMap(([, held]) => held);
    problems.publish([], []);

    const actions = problems.quickFixes.provideCodeActions({ uri: { fsPath: '/deployed/Data/a.esp' } }, undefined, { diagnostics });

    expect(actions).toEqual([]);
  });

  it('is offered on no problem of another source', () => {
    const collection = new FakeDiagnosticCollection();
    const problems = unmanagedProblems(collection);
    problems.publish([at('Data/a.esp')], []);

    const actions = problems.quickFixes.provideCodeActions({ uri: { fsPath: '/deployed/Data/a.esp' } }, undefined, { diagnostics: [new Diagnostic(new Range(0, 0, 0, 0), 'other')] });

    expect(actions).toEqual([]);
  });
});
