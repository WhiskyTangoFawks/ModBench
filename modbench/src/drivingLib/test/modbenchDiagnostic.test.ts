import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Range: class { constructor(readonly startLine: number) {} },
  Diagnostic: class { source?: string; constructor(readonly range: unknown, readonly message: string, readonly severity: number) {} },
}));
import * as vscode from 'vscode';
import { modbenchDiagnostic, PROBLEM_SOURCE } from '../modbenchDiagnostic';

describe('modbenchDiagnostic', () => {
  it('names Modbench as the source of its problem', () => {
    const diagnostic = modbenchDiagnostic(new vscode.Range(0, 0, 0, 0), 'bad', 1);

    expect([diagnostic.message, diagnostic.severity, diagnostic.source]).toEqual(['bad', 1, PROBLEM_SOURCE]);
  });
});
