import { describe, it, expect, vi } from 'vitest';
import { normalize } from 'node:path';
import { Diagnostic, DiagnosticSeverity, Range, uriFile, FakeDiagnosticCollection } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Diagnostic, DiagnosticSeverity, Range, Uri: { file: uriFile } }));

import { BuildProblems } from '../buildProblems';
import { sourceFiles } from '../../instanceLoader/loadOrderSnapshot';
import { valueWithSourceDirs } from './sourceDirsFixture';

describe('a build\'s diagnostics in the Problems panel', () => {
  const diagnosticAt = (sourceRelativePath: string) => [{ formKey: '000000:MyPatch.esp', sourceRelativePath, message: 'bad' }];

  const publishedPaths = (diagnostics: FakeDiagnosticCollection) => [...diagnostics].map(([uri]) => uri.fsPath);

  it("replaces the plugin's own entries, and leaves every other plugin's, its mod's included", () => {
    const diagnostics = new FakeDiagnosticCollection();
    const problems = new BuildProblems(diagnostics);
    const value = valueWithSourceDirs(new Map([['ModA', normalize('/instance/source/ModA')], ['ModB', normalize('/instance/source/ModB')]]));
    const a = { name: 'A.esp', origin: 'ModA' };
    const also = { name: 'Also.esp', origin: 'ModA' };
    const b = { name: 'B.esp', origin: 'ModB' };
    problems.publish(a, sourceFiles(value, 'ModA'), diagnosticAt('A.esp/Old.json'));
    problems.publish(also, sourceFiles(value, 'ModA'), diagnosticAt('Also.esp/Kept.json'));
    problems.publish(b, sourceFiles(value, 'ModB'), diagnosticAt('B.esp/Other.json'));

    problems.publish(a, sourceFiles(value, 'ModA'), diagnosticAt('A.esp/New.json'));

    expect(publishedPaths(diagnostics)).toEqual([
      normalize('/instance/source/ModA/Also.esp/Kept.json'), normalize('/instance/source/ModB/B.esp/Other.json'), normalize('/instance/source/ModA/A.esp/New.json'),
    ]);
  });

  it('publishes nothing when the value knows no folder for the origin', () => {
    const diagnostics = new FakeDiagnosticCollection();

    new BuildProblems(diagnostics).publish({ name: 'A.esp', origin: 'ModA' }, undefined, diagnosticAt('Source/A.psc'));

    expect(publishedPaths(diagnostics)).toEqual([]);
  });
});


