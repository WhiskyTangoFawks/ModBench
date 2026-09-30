// The kernel band's rule (docs/architecture/target-architecture.d2): "a kernel box references
// nothing". Each box is one composite project listing no references, so `tsc -b` is the sweep;
// this scan is the readable failure message beside it.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { present } from '../ports/present';
import { tsFiles } from './tsFiles';

const SRC = join(__dirname, '..');

// One directory per kernel box, as the zoom-out draws the Modbench kernel band.
const KERNEL_BOXES = ['loadOrderFileCodec', 'tables', 'wire', 'ports'];

// The driven column, each with the boxes target-architecture-references.d2 lets it reach: the
// arrows that leave it, plus its column's kernel by the band's rule.
const DRIVEN_BOXES: Record<string, string[]> = {
  instanceAdapter: ['loadOrderFileCodec', 'ports', 'tables'],
  instanceLoader: ['instanceAdapter', 'ports', 'tables'],
};

// The core column, read off the same picture.
const CORE_BOXES: Record<string, string[]> = {
  modlist: ['instanceAdapter', 'ports'],
  pluginsCommands: ['instanceLoader', 'loadOrderFileCodec', 'instanceAdapter', 'ports'],
  instanceCommands: ['client', 'instanceLoader', 'instanceAdapter', 'ports', 'tables'],
  downloadsCommands: ['instanceAdapter', 'ports'],
  install: ['instanceAdapter', 'ports'],
  client: ['ports', 'wire'],
};


// The driving band: each view reads a value and fires a command, with the reference list
// target-architecture-references.d2 draws for it. No Toolbox file uses its drawn deploy commands
// or tables, so both are left out.
const VIEW_BOXES: Record<string, string[]> = {
  toolbox: ['instanceCommands', 'instanceLoader', 'ports'],
  mods: ['install', 'instanceLoader', 'modlist', 'ports'],
  downloads: ['downloadsCommands', 'install', 'instanceLoader', 'ports'],
  plugins: ['client', 'instanceLoader', 'pluginsCommands', 'ports'],
  editor: ['client', 'ports', 'wire'],
};

const REFERENCING_BOXES: Record<string, string[]> = { ...DRIVEN_BOXES, ...CORE_BOXES, ...VIEW_BOXES };

const boxRoot = (box: string): string => join(SRC, box);

// A box's production files: the box directory's own tree minus its tests, which live under
// `test/` and compile in the test project, not in the box's own.
const productionFiles = (root: string): string[] =>
  tsFiles(root, { exclude: ['test'], tsx: false, includeTests: false });

const kernelFiles = (): string[] => KERNEL_BOXES.flatMap((box) => productionFiles(boxRoot(box)));

function importSpecifiers(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// The kernel is pure, values in and values out: a kernel module never opens a file itself, so
// these are disallowed even though every other node: builtin is fine.
const FS_SPECIFIERS = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);

// A relative specifier counts only if it resolves inside the box holding the file; a bare one
// is a package or `vscode`, neither of which a kernel box may name.
function isAllowedSpecifier(spec: string, fromFile: string, root: string): boolean {
  if (FS_SPECIFIERS.has(spec)) return false;
  if (spec.startsWith('node:')) return true;
  if (!spec.startsWith('.')) return false;
  const resolved = resolve(dirname(fromFile), spec);
  return resolved === root || resolved.startsWith(root + '/');
}

function disallowedSpecifiers(path: string, root: string): string[] {
  return importSpecifiers(readFileSync(path, 'utf8'), path).filter((s) => !isAllowedSpecifier(s, path, root));
}

function offenders(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const box of KERNEL_BOXES) {
    for (const path of productionFiles(boxRoot(box))) {
      const bad = disallowedSpecifiers(path, boxRoot(box));
      if (bad.length > 0) found[relative(SRC, path)] = bad;
    }
  }
  return found;
}

// A bare specifier that is not `vscode` is a package, which only the client may name: its HTTP
// adapter is the one place a dependency of the wire lives.
const PACKAGE_IMPORTERS = new Set(['client']);

// The Instance adapter's watch is VS Code's file watcher; every other file of the adapter, and the
// interface commands import, stays free of the extension host.
const ADAPTER_WATCH = join(boxRoot('instanceAdapter'), 'mo2Watch.ts');

const isIn = (root: string, path: string): boolean => path === root || path.startsWith(root + '/');

// What another box reaches of the Instance adapter: its interface, and none of MO2's implementation.
const ADAPTER_INTERFACE = join(boxRoot('instanceAdapter'), 'instanceAdapter');

// A driven or core box may reach the boxes the diagram draws an arrow to, and node: builtins
// including the file system — the Instance adapter is the one door onto the instance, and it is
// one of these.
function isAllowedDrivenSpecifier(spec: string, fromFile: string, box: string): boolean {
  if (spec.startsWith('node:')) return true;
  if (spec === 'vscode') return box in VIEW_BOXES || fromFile === ADAPTER_WATCH;
  if (!spec.startsWith('.')) return PACKAGE_IMPORTERS.has(box);
  const resolved = resolve(dirname(fromFile), spec);
  if (box !== 'instanceAdapter' && isIn(boxRoot('instanceAdapter'), resolved)) return resolved === ADAPTER_INTERFACE;
  const roots = [boxRoot(box), ...present(REFERENCING_BOXES[box], `a reference list for "${box}"`).map(boxRoot)];
  return roots.some((root) => isIn(root, resolved));
}

function drivenOffenders(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const box of Object.keys(REFERENCING_BOXES)) {
    for (const path of productionFiles(boxRoot(box))) {
      const bad = importSpecifiers(readFileSync(path, 'utf8'), path)
        .filter((spec) => !isAllowedDrivenSpecifier(spec, path, box));
      if (bad.length > 0) found[relative(SRC, path)] = bad;
    }
  }
  return found;
}

// A plant lands in a real temporary directory standing in for a box root and runs through the
// same `disallowedSpecifiers`, so gutting that function cannot leave these tests passing.
async function plantedSpecifiers(source: string): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), 'medit-kernel-import-scan-'));
  try {
    const planted = join(root, 'planted.ts');
    await writeFile(planted, source);
    return disallowedSpecifiers(planted, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('a kernel box references nothing', () => {
  it('names every box the kernel band draws', () => {
    expect(KERNEL_BOXES).toEqual(['loadOrderFileCodec', 'tables', 'wire', 'ports']);
  });

  it('every box is a real directory holding production files', () => {
    for (const box of KERNEL_BOXES) {
      expect(existsSync(boxRoot(box))).toBe(true);
      expect(productionFiles(boxRoot(box)).length).toBeGreaterThan(0);
    }
  });

  it('scans a real body of kernel files', () => {
    expect(kernelFiles().length).toBeGreaterThan(10);
  });

  it('every production file in a kernel box imports only node: builtins and files in its own box', () => {
    expect(offenders()).toEqual({});
  });

  // Rival this catches: a kernel module reaching up for a type instead of owning it beside the
  // code that produces it.
  it('flags an import planted upward out of the box', async () => {
    expect(await plantedSpecifiers("import type { ModlistEntry } from '../model';\n")).toEqual(['../model']);
  });

  // Rival this catches: one kernel box reaching for another — the codecs taking `present` from
  // Ports, or the wire taking a game name from the tables.
  it('flags a sibling kernel box import planted in a kernel module', async () => {
    expect(await plantedSpecifiers("import { present } from '../ports/present';\n")).toEqual(['../ports/present']);
  });

  // Rival this catches: a kernel module taking a VS Code type, which drags the extension host
  // into a box the record panel also reads.
  it('flags a vscode import planted in a kernel module', async () => {
    expect(await plantedSpecifiers("import * as vscode from 'vscode';\n")).toEqual(['vscode']);
  });

  // Rival this catches: a codec reaching into node:fs/promises to read the file itself instead
  // of taking its text as a parameter.
  it('flags a node:fs or node:fs/promises import planted in a kernel module', async () => {
    expect(await plantedSpecifiers("import { readFile } from 'node:fs/promises';\nimport { existsSync } from 'node:fs';\n"))
      .toEqual(['node:fs/promises', 'node:fs']);
  });

  it('allows node:path, which a pure path function needs', async () => {
    expect(await plantedSpecifiers("import { join } from 'node:path';\n")).toEqual([]);
  });

  it('allows a file inside the same box', async () => {
    expect(await plantedSpecifiers("import { lineRanges } from './lineScan';\n")).toEqual([]);
  });
});

describe('a driven or core box reaches only the boxes the diagram draws an arrow to', () => {
  it('names the two boxes the driven band draws', () => {
    expect(Object.keys(DRIVEN_BOXES)).toEqual(['instanceAdapter', 'instanceLoader']);
  });

  it('names the six boxes the core band draws and the code builds', () => {
    expect(Object.keys(CORE_BOXES))
      .toEqual(['modlist', 'pluginsCommands', 'instanceCommands', 'downloadsCommands', 'install', 'client']);
  });

  it('names the five views the driving band draws', () => {
    expect(Object.keys(VIEW_BOXES)).toEqual(['toolbox', 'mods', 'downloads', 'plugins', 'editor']);
  });

  it('every box is a real directory holding production files', () => {
    for (const box of Object.keys(REFERENCING_BOXES)) {
      expect(existsSync(boxRoot(box))).toBe(true);
      expect(productionFiles(boxRoot(box)).length).toBeGreaterThan(0);
    }
  });

  it('every production file imports only node: builtins, its own box and the boxes it references', () => {
    expect(drivenOffenders()).toEqual({});
  });

  // Rival: the Instance reaching up into a view or a command, which is what makes the read model
  // an input to the write side.
  it('flags an import of a box no arrow reaches', () => {
    const planted = join(boxRoot('instanceLoader'), 'planted.ts');
    expect(isAllowedDrivenSpecifier('../modmanager/ModListProvider', planted, 'instanceLoader')).toBe(false);
    expect(isAllowedDrivenSpecifier('../client/MEditClient', planted, 'instanceLoader')).toBe(false);
  });

  // Rival: the Instance adapter taking a VS Code type beyond its watch, which puts the extension
  // host behind the interface every command imports (ADR-0002); or the Instance loader taking one,
  // when the adapter owns the watch.
  it('allows vscode below the views in the Instance adapter\'s watch alone', () => {
    expect(isAllowedDrivenSpecifier('vscode', join(boxRoot('instanceLoader'), 'planted.ts'), 'instanceLoader')).toBe(false);
    expect(isAllowedDrivenSpecifier('vscode', ADAPTER_WATCH, 'instanceAdapter')).toBe(true);
    expect(isAllowedDrivenSpecifier('vscode', join(boxRoot('instanceAdapter'), 'instanceAdapter.ts'), 'instanceAdapter')).toBe(false);
    expect(isAllowedDrivenSpecifier('vscode', join(boxRoot('instanceAdapter'), 'planted.ts'), 'instanceAdapter')).toBe(false);
  });

  // Rival: the client taking a VS Code type for a callback, which is what would make a tool
  // handler or a test need an extension host to call it (ADR-0002).
  it('refuses vscode in the mEdit client and in every command box', () => {
    for (const box of Object.keys(CORE_BOXES)) {
      expect(isAllowedDrivenSpecifier('vscode', join(boxRoot(box), 'planted.ts'), box)).toBe(false);
    }
  });

  // Rival: a command reaching for the HTTP adapter's packages, or the client's own `openapi-fetch`
  // spreading past the seam clientSeamBoundary.test.ts draws.
  it('allows a package only in the client', () => {
    expect(isAllowedDrivenSpecifier('openapi-fetch', join(boxRoot('client'), 'p.ts'), 'client')).toBe(true);
    expect(isAllowedDrivenSpecifier('openapi-fetch', join(boxRoot('install'), 'p.ts'), 'install')).toBe(false);
  });

  // Rival: a view taking a splice helper or a game name straight from the kernel instead of
  // from the value the Instance publishes and the reply a command gives it.
  it('refuses a codec and a table in every view', () => {
    for (const box of Object.keys(VIEW_BOXES)) {
      expect(isAllowedDrivenSpecifier('../loadOrderFileCodec/pluginsText', join(boxRoot(box), 'p.ts'), box)).toBe(false);
      expect(isAllowedDrivenSpecifier('../tables/gamePaths', join(boxRoot(box), 'p.ts'), box)).toBe(false);
    }
  });

  // A view is the one band whose whole reason to exist is the extension host.
  it('allows vscode in every view', () => {
    for (const box of Object.keys(VIEW_BOXES)) {
      expect(isAllowedDrivenSpecifier('vscode', join(boxRoot(box), 'p.ts'), box)).toBe(true);
    }
  });

  // Rival: one view reaching another's tree — three views own a copy of the error row rather
  // than sharing one, so a shared import is a boundary crossing, not a convenience.
  it('refuses one view reaching into another', () => {
    expect(isAllowedDrivenSpecifier('../downloads/errorNode', join(boxRoot('mods'), 'p.ts'), 'mods')).toBe(false);
    expect(isAllowedDrivenSpecifier('../plugins/PluginTreeProvider', join(boxRoot('editor'), 'p.ts'), 'editor')).toBe(false);
    expect(isAllowedDrivenSpecifier('../mods/ModListProvider', join(boxRoot('plugins'), 'p.ts'), 'plugins')).toBe(false);
  });

  // Rival: a box reaching past the Instance adapter's interface into MO2's codecs or its layout,
  // which puts the mod manager's formats outside its implementation (target-architecture.md, Rules
  // the Modbench column draws).
  it('refuses every box but the Instance adapter anything of the adapter\'s beyond its interface', () => {
    for (const box of Object.keys(REFERENCING_BOXES).filter((b) => b !== 'instanceAdapter')) {
      const planted = join(boxRoot(box), 'p.ts');
      expect(isAllowedDrivenSpecifier('../instanceAdapter/codecs/modlistText', planted, box)).toBe(false);
      expect(isAllowedDrivenSpecifier('../instanceAdapter/layout', planted, box)).toBe(false);
    }
    const inAdapter = join(boxRoot('instanceAdapter'), 'p.ts');
    expect(isAllowedDrivenSpecifier('./codecs/modlistText', inAdapter, 'instanceAdapter')).toBe(true);
  });

  it('allows the boxes each one does reference', () => {
    expect(isAllowedDrivenSpecifier('../instanceAdapter/instanceAdapter', join(boxRoot('instanceLoader'), 'p.ts'), 'instanceLoader')).toBe(true);
    expect(isAllowedDrivenSpecifier(
      '../loadOrderFileCodec/pluginsText', join(boxRoot('instanceAdapter'), 'p.ts'), 'instanceAdapter',
    )).toBe(true);
    expect(isAllowedDrivenSpecifier('node:fs/promises', join(boxRoot('instanceAdapter'), 'p.ts'), 'instanceAdapter')).toBe(true);
    expect(isAllowedDrivenSpecifier(
      '../instanceLoader/fileConflictIndex', join(boxRoot('pluginsCommands'), 'p.ts'), 'pluginsCommands',
    )).toBe(true);
    expect(isAllowedDrivenSpecifier('../instanceLoader/instance', join(boxRoot('install'), 'p.ts'), 'install')).toBe(false);
  });
});
