import { noGestureResultUse } from '../../eslint-rules/noGestureResultUse.mjs';
import { RuleTester } from './ruleTester';

const MESSAGE =
  "An entry point may fire a gesture and use no result. A gesture that needs another box's work "
  + 'calls that box through a project reference.';

const fails = (name: string, code: string) => ({ name, code, errors: [{ message: MESSAGE }] });

new RuleTester().run('no-gesture-result-use', noGestureResultUse, {
  valid: [
    { name: 'a bare, unawaited fire', code: "vscode.commands.executeCommand('modbench.x');\n" },
    { name: 'a bare, awaited fire', code: "async function f() { await vscode.commands.executeCommand('modbench.x'); }\n" },
    { name: 'a void-wrapped fire', code: "void vscode.commands.executeCommand('modbench.x');\n" },
    { name: 'a relay callback whose whole body is the fire (recordPanelHost.ts\'s shape)', code: "registerCommand('modbench.x', () => vscode.commands.executeCommand('modbench.referencedByTree.focus'));\n" },
    { name: 'an executeCommand call whose command is not a modbench.… literal', code: "const r = vscode.commands.executeCommand('setContext', 'modbench.record.filterActive', true);\n" },
  ],
  invalid: [
    fails('an assignment of the result', "async function f() { const r = await vscode.commands.executeCommand('modbench.x'); return r; }\n"),
    fails('a return of the result', "function f() { return vscode.commands.executeCommand('modbench.x'); }\n"),
    fails('a return of the awaited result', "async function f() { return await vscode.commands.executeCommand('modbench.x'); }\n"),
    fails('the result tested in a condition', "async function f() { if (await vscode.commands.executeCommand('modbench.x')) { return; } }\n"),
    fails('the result passed on as another call\'s argument', "async function f() { use(await vscode.commands.executeCommand('modbench.x')); }\n"),
  ],
});
