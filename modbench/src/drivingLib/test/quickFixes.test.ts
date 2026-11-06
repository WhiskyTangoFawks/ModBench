import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => {
  const mock = await import('../../test/vscodeMock');
  class CodeAction {
    diagnostics: unknown[] = [];
    command: unknown;
    constructor(readonly title: string, readonly kind: string) {}
  }
  return { Diagnostic: mock.Diagnostic, Range: mock.Range, DiagnosticSeverity: mock.DiagnosticSeverity, Uri: { ...mock.Uri, parse: mock.uriParse }, CodeAction, CodeActionKind: { QuickFix: 'quickfix' } };
});

import { Diagnostic, Range, DiagnosticSeverity } from '../../test/vscodeMock';
import { commandLink, quickFixes } from '../quickFixes';

const problemWith = (code: unknown, source = 'Modbench') => Object.assign(new Diagnostic(new Range(0, 0, 0, 0), 'wrong', DiagnosticSeverity.Warning), { code, source });
const offered = (...diagnostics: Diagnostic[]) => quickFixes.provideCodeActions({ uri: {} }, undefined, { diagnostics });

describe('quickFixes: a problem whose code is a link to a gesture offers that gesture', () => {
  it('is a quick fix titled by the link, firing the link\'s command with its arguments, on the problem', () => {
    const problem = problemWith(commandLink('move to Overwrite', 'modbench.instance.moveToOverwrite', [['Data/a.esp']]));

    const [fix] = offered(problem);

    expect([fix?.title, fix?.kind, fix?.command, fix?.diagnostics]).toEqual([
      'Move to Overwrite', 'quickfix', { command: 'modbench.instance.moveToOverwrite', title: 'Move to Overwrite', arguments: [['Data/a.esp']] }, [problem],
    ]);
  });

  it.each([
    ['a code that is no link', 'other', 'Modbench'],
    ['a problem with no code', undefined, 'Modbench'],
    ['a link to a web page', { value: 'docs', target: { scheme: 'https', path: '/x', query: '' } }, 'Modbench'],
    ['another source\'s problem', commandLink('clear', 'x.y', []), 'Other'],
  ])('offers nothing on %s', (_label, code, source) => {
    expect(offered(problemWith(code, source))).toEqual([]);
  });
});
