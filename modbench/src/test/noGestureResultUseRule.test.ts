// commands.md: "An entry point fires a gesture. A gesture does not fire another." Exercised
// through the real ESLint Linter, not by re-deriving the rule's predicate logic.
import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import { noGestureResultUse } from '../../eslint-rules/noGestureResultUse.mjs';

const MESSAGE =
  "An entry point may fire a gesture and use no result. A gesture that needs another box's work "
  + 'calls that box through a reference the reference view draws.';

function lint(code: string): Linter.LintMessage[] {
  const linter = new Linter();
  return linter.verify(code, {
    plugins: { local: { rules: { x: noGestureResultUse } } },
    rules: { 'local/x': 'error' },
  });
}

describe('no-gesture-result-use', () => {
  it('fails a planted assignment of the result, with the rule\'s own message', () => {
    const messages = lint("async function f() { const r = await vscode.commands.executeCommand('modbench.x'); return r; }\n");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toBe(MESSAGE);
  });

  it('fails a planted return of the result', () => {
    const messages = lint("function f() { return vscode.commands.executeCommand('modbench.x'); }\n");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toBe(MESSAGE);
  });

  it('fails a planted return of the awaited result', () => {
    const messages = lint("async function f() { return await vscode.commands.executeCommand('modbench.x'); }\n");

    expect(messages).toHaveLength(1);
  });

  it('fails the result tested in a condition', () => {
    const messages = lint("async function f() { if (await vscode.commands.executeCommand('modbench.x')) { return; } }\n");

    expect(messages).toHaveLength(1);
  });

  it('fails the result passed on as another call\'s argument', () => {
    const messages = lint("async function f() { use(await vscode.commands.executeCommand('modbench.x')); }\n");

    expect(messages).toHaveLength(1);
  });

  it('passes a bare, unawaited fire', () => {
    const messages = lint("vscode.commands.executeCommand('modbench.x');\n");

    expect(messages).toEqual([]);
  });

  it('passes a bare, awaited fire', () => {
    const messages = lint("async function f() { await vscode.commands.executeCommand('modbench.x'); }\n");

    expect(messages).toEqual([]);
  });

  it('passes a void-wrapped fire', () => {
    const messages = lint("void vscode.commands.executeCommand('modbench.x');\n");

    expect(messages).toEqual([]);
  });

  it('passes a relay callback whose whole body is the fire (recordPanelHost.ts\'s shape)', () => {
    const messages = lint("registerCommand('modbench.record.showReferencedBy', () => vscode.commands.executeCommand('modbench.referencedByTree.focus'));\n");

    expect(messages).toEqual([]);
  });

  it('ignores an executeCommand call whose command is not a modbench.… literal', () => {
    const messages = lint("const r = vscode.commands.executeCommand('setContext', 'modbench.record.filterActive', true);\n");

    expect(messages).toEqual([]);
  });
});
