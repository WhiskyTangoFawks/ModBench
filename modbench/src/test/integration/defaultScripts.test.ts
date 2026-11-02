import * as assert from 'assert';
import * as vscode from 'vscode';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it } from 'mocha';
import { defaultScriptIn } from '../../agent/defaultScripts';

describe('the default scripts a folder holds', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function shipped(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'modbench-default-scripts-'));
    roots.push(root);
    mkdirSync(path.join(root, 'default'));
    writeFileSync(path.join(root, 'default', 'clean.py'), '');
    writeFileSync(path.join(root, 'medit.py'), '');
    return path.join(root, 'default');
  }

  it('answers the path of a script by its name', async () => {
    const folder = shipped();

    assert.strictEqual(await defaultScriptIn(vscode.Uri.file(folder))('clean'), vscode.Uri.file(path.join(folder, 'clean.py')).fsPath);
  });

  it('answers nothing for a name that is not a script of the folder, though a file of that name is reached through it', async () => {
    const folder = vscode.Uri.file(shipped());

    assert.deepStrictEqual(await Promise.all(['missing', '../medit', 'clean.py', ''].map((name) => defaultScriptIn(folder)(name))), [undefined, undefined, undefined, undefined]);
  });
});
