import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { productionFiles, SRC } from './scanSource';

const ALLOWED = new Set([join('instanceAdapter', 'mo2Watch.ts')]);

const WATCHER_FACTORY = /^create\w*Watcher$/;

function trailingNameOfCallTarget(node: ts.CallExpression): string | undefined {
  const target = node.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

function watcherFactoryCalls(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = trailingNameOfCallTarget(node);
      if (name !== undefined && WATCHER_FACTORY.test(name)) found.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('every watcher on the instance is created inside the Instance adapter\'s watch, as a view or command wiring its own would duplicate the recompute trigger', () => {
  it('scans a real body of files', () => {
    expect(productionFiles(SRC).length).toBeGreaterThan(100);
  });

  it('no other production file calls a watcher factory', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of productionFiles(SRC)) {
      const rel = relative(SRC, path);
      if (ALLOWED.has(rel)) continue;
      const calls = watcherFactoryCalls(readFileSync(path, 'utf8'), path);
      if (calls.length > 0) offenders[rel] = calls;
    }
    expect(offenders).toEqual({});
  });

  it('flags a watcher factory call planted outside the allowed files', () => {
    const planted = "createOverwriteWatcher(instanceRoot, () => provider.invalidate());\n";
    expect(watcherFactoryCalls(planted, 'planted.ts')).toEqual(['createOverwriteWatcher']);
  });

  it('flags a raw vscode.workspace.createFileSystemWatcher call the same way', () => {
    const planted = "vscode.workspace.createFileSystemWatcher('mods/**');\n";
    expect(watcherFactoryCalls(planted, 'planted.ts')).toEqual(['createFileSystemWatcher']);
  });
});
