import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, Range, DiagnosticSeverity, FakeDiagnosticCollection, uriParse, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Diagnostic, Range, DiagnosticSeverity, Uri: { ...Uri, parse: uriParse } }));

import { publishUnmanagedProblems } from '../unmanagedProblems';

const at = (path: string) => ({ path, file: `/deployed/${path}` });

const published = (collection: FakeDiagnosticCollection) =>
  [...collection].map(([uri, [problem]]) => ({ path: uri.fsPath, severity: problem?.severity, message: problem?.message, code: problem?.code }));

describe('the problems on files deploy does not manage', () => {
  it('is one warning on each file, at its path below the deployment folder', () => {
    const collection = new FakeDiagnosticCollection();

    publishUnmanagedProblems(collection, [at('Data/MCM/settings.ini'), at('game.exe')], []);

    expect(published(collection).map(({ path, severity, message }) => [path, severity, message])).toEqual([
      ['/deployed/Data/MCM/settings.ini', DiagnosticSeverity.Warning, 'Deploy does not manage this file.'],
      ['/deployed/game.exe', DiagnosticSeverity.Warning, 'Deploy does not manage this file.'],
    ]);
  });

  it('names the file it left out, when the path of a file the game gets holds this file', () => {
    const collection = new FakeDiagnosticCollection();

    publishUnmanagedProblems(collection, [at('Data/a.esp')], [{ path: 'Data/a.esp', winner: '/instance/mods/Mod/a.esp' }]);

    expect(published(collection)[0]?.message).toBe('Deploy does not manage this file, and left out /instance/mods/Mod/a.esp, which the game would get at its path.');
  });

  it('links move to Overwrite on a file where a mod file can land at its path, and on no other', () => {
    const collection = new FakeDiagnosticCollection();

    publishUnmanagedProblems(collection, [at('Data/MCM/settings.ini'), at('Data/.hidden')], []);

    expect(published(collection).map(({ code }) => code)).toEqual([
      { value: 'move to Overwrite', target: uriParse(`command:modbench.instance.moveToOverwrite?${encodeURIComponent(JSON.stringify([['Data/MCM/settings.ini']]))}`) },
      undefined,
    ]);
  });

  it('replaces the files it held, so a file that is gone has no problem', () => {
    const collection = new FakeDiagnosticCollection();
    publishUnmanagedProblems(collection, [at('a.exe'), at('b.exe')], []);

    publishUnmanagedProblems(collection, [at('b.exe')], []);

    expect(published(collection).map(({ path }) => path)).toEqual(['/deployed/b.exe']);
  });
});
