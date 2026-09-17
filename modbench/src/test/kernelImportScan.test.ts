// The kernel band's rule (docs/architecture/target-architecture.d2): "a kernel box references
// nothing". Each box is one composite project listing no references, so `tsc -b` is the sweep;
// this scan is the readable failure message beside it.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { present } from '../ports/present';

const SRC = join(__dirname, '..');

// One directory per kernel box, as the zoom-out draws the Modbench kernel band.
const KERNEL_BOXES = ['mo2Codecs', 'tables', 'wire', 'ports'];

// The driven column, each with the boxes target-architecture-references.d2 lets it reach: the
// arrows that leave it, plus its column's kernel by the band's rule.
const DRIVEN_BOXES: Record<string, string[]> = {
  mo2Files: ['mo2Codecs', 'ports', 'tables'],
  instance: ['mo2Codecs', 'mo2Files', 'ports', 'tables'],
};

// The core column, read off the same picture.
const CORE_BOXES: Record<string, string[]> = {
  modlist: ['mo2Codecs', 'mo2Files', 'ports'],
  pluginsCommands: ['instance', 'mo2Codecs', 'mo2Files'],
  instanceCommands: ['mo2Codecs', 'mo2Files'],
  install: ['mo2Codecs', 'mo2Files', 'ports'],
  deploy: ['instance', 'mo2Files'],
  client: ['wire'],
};


// The driving band: each view reads a value and fires a command, with the reference list
// target-architecture-references.d2 draws for it.
const VIEW_BOXES: Record<string, string[]> = {
  mods: ['install', 'instance', 'modlist', 'ports'],
  downloads: ['install', 'instance', 'ports'],
  plugins: ['client', 'instance', 'pluginsCommands', 'ports'],
  editor: ['client', 'ports', 'wire'],
};

const REFERENCING_BOXES: Record<string, string[]> = { ...DRIVEN_BOXES, ...CORE_BOXES, ...VIEW_BOXES };

const boxRoot = (box: string): string => join(SRC, box);

// A box's production files: the box directory's own tree minus its tests, which live under
// `test/` and compile in the test project, not in the box's own.
function productionFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'test') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...productionFiles(path));
    else if (extname(entry.name) === '.ts' && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

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

// A driven or core box may reach the boxes the diagram draws an arrow to, and node: builtins
// including the file system — MO2 files is the one door onto the instance, and it is one of these.
function isAllowedDrivenSpecifier(spec: string, fromFile: string, box: string): boolean {
  if (spec.startsWith('node:')) return true;
  if (spec === 'vscode') return box === 'instance' || box in VIEW_BOXES;
  if (!spec.startsWith('.')) return PACKAGE_IMPORTERS.has(box);
  const resolved = resolve(dirname(fromFile), spec);
  const roots = [boxRoot(box), ...present(REFERENCING_BOXES[box], `a reference list for "${box}"`).map(boxRoot)];
  return roots.some((root) => resolved === root || resolved.startsWith(root + '/'));
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
    expect(KERNEL_BOXES).toEqual(['mo2Codecs', 'tables', 'wire', 'ports']);
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
    expect(Object.keys(DRIVEN_BOXES)).toEqual(['mo2Files', 'instance']);
  });

  it('names the six boxes the core band draws', () => {
    expect(Object.keys(CORE_BOXES))
      .toEqual(['modlist', 'pluginsCommands', 'instanceCommands', 'install', 'deploy', 'client']);
  });

  it('names the four views the driving band draws, less the Toolbox', () => {
    expect(Object.keys(VIEW_BOXES)).toEqual(['mods', 'downloads', 'plugins', 'editor']);
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
    const planted = join(boxRoot('instance'), 'planted.ts');
    expect(isAllowedDrivenSpecifier('../modmanager/ModListProvider', planted, 'instance')).toBe(false);
    expect(isAllowedDrivenSpecifier('../client/MEditClient', planted, 'instance')).toBe(false);
  });

  // Rival: MO2 files taking a VS Code type, which puts the extension host behind the one door
  // onto the instance. The Instance owns the watchers, so vscode is its alone.
  it('allows vscode in the Instance and refuses it in MO2 files', () => {
    expect(isAllowedDrivenSpecifier('vscode', join(boxRoot('instance'), 'planted.ts'), 'instance')).toBe(true);
    expect(isAllowedDrivenSpecifier('vscode', join(boxRoot('mo2Files'), 'planted.ts'), 'mo2Files')).toBe(false);
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
      expect(isAllowedDrivenSpecifier('../mo2Codecs/modlistText', join(boxRoot(box), 'p.ts'), box)).toBe(false);
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

  it('allows the boxes each one does reference', () => {
    expect(isAllowedDrivenSpecifier('../mo2Files/layout', join(boxRoot('instance'), 'p.ts'), 'instance')).toBe(true);
    expect(isAllowedDrivenSpecifier('../mo2Codecs/metaIni', join(boxRoot('mo2Files'), 'p.ts'), 'mo2Files')).toBe(true);
    expect(isAllowedDrivenSpecifier('node:fs/promises', join(boxRoot('mo2Files'), 'p.ts'), 'mo2Files')).toBe(true);
    expect(isAllowedDrivenSpecifier('../instance/fileConflictIndex', join(boxRoot('deploy'), 'p.ts'), 'deploy')).toBe(true);
    expect(isAllowedDrivenSpecifier('../instance/instance', join(boxRoot('install'), 'p.ts'), 'install')).toBe(false);
  });
});
