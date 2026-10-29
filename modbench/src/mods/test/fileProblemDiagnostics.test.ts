import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, DiagnosticSeverity, Range, FakeDiagnosticCollection, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Diagnostic, DiagnosticSeverity, Range, Uri }));

import { FileProblemDiagnostics } from '../fileProblemDiagnostics';

const FILE = '/instance/ModOrganizer.ini';
const shown = (collection: FakeDiagnosticCollection) => (collection.get(Uri.file(FILE)) ?? []).map(({ range, message }) => [range, message]);

describe('a file\'s problems in the Problems panel', () => {
  it('shows a problem on its line, zero-based, and a problem with no line on the file\'s first line', () => {
    const collection = new FakeDiagnosticCollection();

    new FileProblemDiagnostics(collection as never).set(FILE, [{ message: 'on a line', line: 4 }, { message: 'on the file' }]);

    expect(shown(collection)).toEqual([
      [new Range(3, 0, 3, Number.MAX_SAFE_INTEGER), 'on a line'], [new Range(0, 0, 0, 0), 'on the file'],
    ]);
  });

  it('clears a file whose problems are none, and every file on clearAll', () => {
    const collection = new FakeDiagnosticCollection();
    const problems = new FileProblemDiagnostics(collection as never);
    problems.set(FILE, [{ message: 'a' }]);
    problems.set('/other', [{ message: 'b' }]);

    problems.set(FILE, []);
    const afterOne = shown(collection);
    problems.clearAll();

    expect([afterOne, collection.get(Uri.file('/other'))]).toEqual([[], undefined]);
  });
});
