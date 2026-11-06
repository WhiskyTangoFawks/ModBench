import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, Range, DiagnosticSeverity, FakeDiagnosticCollection, Uri, uriParse } from '../../test/vscodeMock';

vi.mock('vscode', () => {
  return { Diagnostic, Range, DiagnosticSeverity, Uri: { ...Uri, parse: uriParse } };
});

import { unmanagedProblems } from '../unmanagedProblems';

const at = (path: string) => ({ path, file: `/deployed/${path}` });

const published = (collection: FakeDiagnosticCollection) =>
  [...collection].map(([uri, [problem]]) => ({ path: uri.fsPath, severity: problem?.severity, message: problem?.message }));

describe('the problems on files deploy does not manage', () => {
  it('is one warning on each file, at where it is', () => {
    const collection = new FakeDiagnosticCollection();

    unmanagedProblems(collection).publish([at('Data/MCM/settings.ini'), at('game.exe')], []);

    expect(published(collection).map(({ path, severity, message }) => [path, severity, message])).toEqual([
      ['/deployed/Data/MCM/settings.ini', DiagnosticSeverity.Warning, 'Deploy does not manage this file.'],
      ['/deployed/game.exe', DiagnosticSeverity.Warning, 'Deploy does not manage this file.'],
    ]);
  });

  it('carries move to Overwrite as its code, a link that fires the gesture on its path', () => {
    const collection = new FakeDiagnosticCollection();

    unmanagedProblems(collection).publish([at('Data/a.esp')], []);

    expect([...collection].flatMap(([, held]) => held.map(({ code }) => code))).toEqual([{
      value: 'move to Overwrite',
      target: uriParse(`command:modbench.instance.moveToOverwrite?${encodeURIComponent(JSON.stringify([['Data/a.esp']]))}`),
    }]);
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

describe('the link on a file deploy does not manage', () => {
  it('is offered on no file where no mod file can land at its path', () => {
    const collection = new FakeDiagnosticCollection();
    unmanagedProblems(collection).publish([at('Data/.hidden')], []);

    expect([...collection].flatMap(([, held]) => held.map(({ code }) => code))).toEqual([undefined]);
  });
});
