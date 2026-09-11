// ADR-0015 invariant 7: the Instance owns every MO2-side watcher. A view or command wiring its own
// watcher would duplicate the Instance's recompute trigger instead of reading its value.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import ts from 'typescript';

const SRC = join(__dirname, '..');

// instance.ts owns every watcher; each watcher module calls the factory one level down
// (createDebouncedFsWatcher or vscode.workspace.createFileSystemWatcher) to define its own.
const ALLOWED = new Set([
  join('modmanager', 'instance.ts'),
  join('modmanager', 'fsWatcher.ts'),
  join('modmanager', 'modsWatcher.ts'),
  join('modmanager', 'modlistWatcher.ts'),
  join('modmanager', 'pluginsTxtWatcher.ts'),
  join('modmanager', 'overwriteWatcher.ts'),
  join('modmanager', 'downloadsWatcher.ts'),
]);

const WATCHER_FACTORY = /^create\w*Watcher$/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'generated') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (extname(entry.name) === '.ts' && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

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
    expect(tsFiles(SRC).length).toBeGreaterThan(100);
  });

  it('no other production file calls a watcher factory', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of tsFiles(SRC)) {
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
