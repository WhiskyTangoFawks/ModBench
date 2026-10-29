import { describe, it, expect, vi } from 'vitest';
import { Diagnostic, DiagnosticSeverity, Range, FakeDiagnosticCollection, Uri } from './vscodeMock';

vi.mock('vscode', () => ({ Diagnostic, DiagnosticSeverity, Range, Uri }));

import { problemsHostOver } from '../problemsHost';

const FILE = '/instance/ModOrganizer.ini';

describe('the Problems panel as VS Code gives it', () => {
  it('shows a warning on its line, zero-based, in the file\'s diagnostics', () => {
    const collection = new FakeDiagnosticCollection();
    const host = problemsHostOver(collection);

    host.publish(FILE, [host.diagnostic({ line: 4, message: 'a path' })]);

    expect((collection.get(Uri.file(FILE)) ?? []).map(({ range, message, severity }) => [range, message, severity]))
      .toEqual([[new Range(3, 0, 3, Number.MAX_SAFE_INTEGER), 'a path', DiagnosticSeverity.Warning]]);
  });

  it('holds no diagnostic for a file published none, and none for any file once cleared', () => {
    const collection = new FakeDiagnosticCollection();
    const host = problemsHostOver(collection);
    host.publish(FILE, [host.diagnostic({ line: 1, message: 'x' })]);
    host.publish('/other', [host.diagnostic({ line: 1, message: 'y' })]);

    host.publish(FILE, []);
    const afterNone = (collection.get(Uri.file(FILE)) ?? []).length;
    host.clearAll();

    expect([afterNone, collection.get(Uri.file('/other'))]).toEqual([0, undefined]);
  });
});
