// ADR-0015 invariant 7: the Instance owns every MO2-side watcher. A view or command wiring its own
// watcher would duplicate the Instance's recompute trigger instead of reading its value.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { tsFiles } from '../../test/tsFiles';

const SRC = join(__dirname, '..', '..');

// instance.ts owns every watcher; each watcher module calls the factory one level down
// (createDebouncedFsWatcher or vscode.workspace.createFileSystemWatcher) to define its own.
const ALLOWED = new Set([
  join('instanceLoader', 'instance.ts'),
  join('instanceLoader', 'fsWatcher.ts'),
  join('instanceLoader', 'modsWatcher.ts'),
  join('instanceLoader', 'modlistWatcher.ts'),
  join('instanceLoader', 'pluginsTxtWatcher.ts'),
  join('instanceLoader', 'overwriteWatcher.ts'),
  join('instanceLoader', 'downloadsWatcher.ts'),
]);

const WATCHER_FACTORY = /^create\w*Watcher$/;

const PRODUCTION_FILES: Parameters<typeof tsFiles>[1] = { exclude: ['generated'], tsx: false, includeTests: false };

// The trailing name of a call target: `vscode.workspace.createFileSystemWatcher` reads as
// `createFileSystemWatcher`, `createModsWatcher(...)` as `createModsWatcher`.
function calleeName(node: ts.CallExpression): string | undefined {
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
      const name = calleeName(node);
      if (name !== undefined && WATCHER_FACTORY.test(name)) found.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('every MO2-side watcher is created inside the Instance or a watcher module', () => {
  it('scans a real body of files', () => {
    expect(tsFiles(SRC, PRODUCTION_FILES).length).toBeGreaterThan(100);
  });

  it('no other production file calls a watcher factory', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of tsFiles(SRC, PRODUCTION_FILES)) {
      const rel = relative(SRC, path);
      if (ALLOWED.has(rel)) continue;
      const calls = watcherFactoryCalls(readFileSync(path, 'utf8'), path);
      if (calls.length > 0) offenders[rel] = calls;
    }
    expect(offenders).toEqual({});
  });

  // Rival this catches: a view or command registering its own watcher instead of reading the
  // Instance's value or subscribing to it.
  it('flags a watcher factory call planted outside the allowed files', () => {
    const planted = "createOverwriteWatcher(instanceRoot, () => provider.invalidate());\n";
    expect(watcherFactoryCalls(planted, 'planted.ts')).toEqual(['createOverwriteWatcher']);
  });

  it('flags a raw vscode.workspace.createFileSystemWatcher call the same way', () => {
    const planted = "vscode.workspace.createFileSystemWatcher('mods/**');\n";
    expect(watcherFactoryCalls(planted, 'planted.ts')).toEqual(['createFileSystemWatcher']);
  });
});
