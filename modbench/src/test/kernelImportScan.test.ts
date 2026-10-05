import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { importSpecifiers } from './scanSource';
import { tsFiles } from './tsFiles';
import { CORE_BOXES, DRIVING_BOXES, KERNEL_BOXES, REFERENCING_BOXES, referencesOf } from './boxes';

const SRC = join(__dirname, '..');

const boxRoot = (box: string): string => join(SRC, box);

const productionFiles = (root: string): string[] =>
  tsFiles(root, { exclude: ['test'], tsx: false, includeTests: false });

const kernelFiles = (): string[] => KERNEL_BOXES.flatMap((box) => productionFiles(boxRoot(box)));

const FS_SPECIFIERS = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);

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

const PACKAGE_IMPORTERS = new Set(['client']);

const ADAPTER_WATCH = join(boxRoot('instanceAdapter'), 'mo2Watch.ts');

const isIn = (root: string, path: string): boolean => path === root || path.startsWith(root + '/');

const ADAPTER_INTERFACE = join(boxRoot('instanceAdapter'), 'instanceAdapter');

function isAllowedBoxSpecifier(spec: string, fromFile: string, box: string): boolean {
  if (spec.startsWith('node:')) return true;
  if (spec === 'vscode') return DRIVING_BOXES.includes(box) || fromFile === ADAPTER_WATCH;
  if (!spec.startsWith('.')) return PACKAGE_IMPORTERS.has(box);
  const resolved = resolve(dirname(fromFile), spec);
  if (box !== 'instanceAdapter' && isIn(boxRoot('instanceAdapter'), resolved)) return resolved === ADAPTER_INTERFACE;
  const roots = [boxRoot(box), ...referencesOf(box).map(boxRoot)];
  return roots.some((root) => isIn(root, resolved));
}

function boxOffenders(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const box of REFERENCING_BOXES) {
    for (const path of productionFiles(boxRoot(box))) {
      const bad = importSpecifiers(readFileSync(path, 'utf8'), path)
        .filter((spec) => !isAllowedBoxSpecifier(spec, path, box));
      if (bad.length > 0) found[relative(SRC, path)] = bad;
    }
  }
  return found;
}

const rootFiles = (): string[] => productionFiles(SRC).filter((path) => {
  const rel = relative(SRC, path);
  return !rel.includes(sep);
});

const MO2_CONSTRUCTION = { file: join(SRC, 'extension.ts'), module: join(boxRoot('instanceAdapter'), 'mo2Instance') };

function isAllowedRootSpecifier(spec: string, fromFile: string): boolean {
  if (!spec.startsWith('.')) return true;
  const resolved = resolve(dirname(fromFile), spec);
  if (!isIn(boxRoot('instanceAdapter'), resolved)) return true;
  return resolved === ADAPTER_INTERFACE || (fromFile === MO2_CONSTRUCTION.file && resolved === MO2_CONSTRUCTION.module);
}

function rootOffenders(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const path of rootFiles()) {
    const bad = importSpecifiers(readFileSync(path, 'utf8'), path).filter((spec) => !isAllowedRootSpecifier(spec, path));
    if (bad.length > 0) found[relative(SRC, path)] = bad;
  }
  return found;
}

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

  it('flags an import planted upward out of the box', async () => {
    expect(await plantedSpecifiers("import type { ModlistEntry } from '../model';\n")).toEqual(['../model']);
  });

  it('flags a sibling kernel box import planted in a kernel module', async () => {
    expect(await plantedSpecifiers("import { present } from '../ports/present';\n")).toEqual(['../ports/present']);
  });

  it('flags a vscode import planted in a kernel module', async () => {
    expect(await plantedSpecifiers("import * as vscode from 'vscode';\n")).toEqual(['vscode']);
  });

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

describe('a box reaches only the boxes its project references', () => {
  it('every box is a real directory holding production files', () => {
    for (const box of REFERENCING_BOXES) {
      expect(existsSync(boxRoot(box))).toBe(true);
      expect(productionFiles(boxRoot(box)).length).toBeGreaterThan(0);
    }
  });

  it('every production file imports only node: builtins, its own box and the boxes it references', () => {
    expect(boxOffenders()).toEqual({});
  });

  it('flags an import of a box the project does not reference', () => {
    const planted = join(boxRoot('instanceLoader'), 'planted.ts');
    expect(isAllowedBoxSpecifier('../modmanager/ModListProvider', planted, 'instanceLoader')).toBe(false);
    expect(isAllowedBoxSpecifier('../client/MEditClient', planted, 'instanceLoader')).toBe(false);
  });

  it('allows vscode below the views in the Instance adapter\'s watch alone', () => {
    expect(isAllowedBoxSpecifier('vscode', join(boxRoot('instanceLoader'), 'planted.ts'), 'instanceLoader')).toBe(false);
    expect(isAllowedBoxSpecifier('vscode', ADAPTER_WATCH, 'instanceAdapter')).toBe(true);
    expect(isAllowedBoxSpecifier('vscode', join(boxRoot('instanceAdapter'), 'instanceAdapter.ts'), 'instanceAdapter')).toBe(false);
    expect(isAllowedBoxSpecifier('vscode', join(boxRoot('instanceAdapter'), 'planted.ts'), 'instanceAdapter')).toBe(false);
  });

  it('refuses vscode in the mEdit client and in every command box', () => {
    for (const box of CORE_BOXES) {
      expect(isAllowedBoxSpecifier('vscode', join(boxRoot(box), 'planted.ts'), box)).toBe(false);
    }
  });

  it('allows a package only in the client', () => {
    expect(isAllowedBoxSpecifier('openapi-fetch', join(boxRoot('client'), 'p.ts'), 'client')).toBe(true);
    expect(isAllowedBoxSpecifier('openapi-fetch', join(boxRoot('install'), 'p.ts'), 'install')).toBe(false);
  });

  it('refuses a codec and a table in every driving box', () => {
    for (const box of DRIVING_BOXES) {
      expect(isAllowedBoxSpecifier('../loadOrderFileCodec/pluginsText', join(boxRoot(box), 'p.ts'), box)).toBe(false);
      expect(isAllowedBoxSpecifier('../tables/gamePaths', join(boxRoot(box), 'p.ts'), box)).toBe(false);
    }
  });

  it('allows vscode in every driving box', () => {
    for (const box of DRIVING_BOXES) {
      expect(isAllowedBoxSpecifier('vscode', join(boxRoot(box), 'p.ts'), box)).toBe(true);
    }
  });

  it('refuses one view reaching into another', () => {
    expect(isAllowedBoxSpecifier('../downloads/DownloadsProvider', join(boxRoot('mods'), 'p.ts'), 'mods')).toBe(false);
    expect(isAllowedBoxSpecifier('../plugins/PluginTreeProvider', join(boxRoot('editor'), 'p.ts'), 'editor')).toBe(false);
    expect(isAllowedBoxSpecifier('../mods/ModListProvider', join(boxRoot('plugins'), 'p.ts'), 'plugins')).toBe(false);
  });

  it('refuses every box but the Instance adapter anything of the adapter\'s beyond its interface', () => {
    for (const box of REFERENCING_BOXES.filter((b) => b !== 'instanceAdapter')) {
      const planted = join(boxRoot(box), 'p.ts');
      expect(isAllowedBoxSpecifier('../instanceAdapter/codecs/modlistText', planted, box)).toBe(false);
      expect(isAllowedBoxSpecifier('../instanceAdapter/layout', planted, box)).toBe(false);
    }
    const inAdapter = join(boxRoot('instanceAdapter'), 'p.ts');
    expect(isAllowedBoxSpecifier('./codecs/modlistText', inAdapter, 'instanceAdapter')).toBe(true);
  });

  it('allows the boxes each one does reference', () => {
    expect(isAllowedBoxSpecifier('../instanceAdapter/instanceAdapter', join(boxRoot('instanceLoader'), 'p.ts'), 'instanceLoader')).toBe(true);
    expect(isAllowedBoxSpecifier(
      '../loadOrderFileCodec/pluginsText', join(boxRoot('instanceAdapter'), 'p.ts'), 'instanceAdapter',
    )).toBe(true);
    expect(isAllowedBoxSpecifier('node:fs/promises', join(boxRoot('instanceAdapter'), 'p.ts'), 'instanceAdapter')).toBe(true);
    expect(isAllowedBoxSpecifier('../loadOrderFileCodec/pluginsText', join(boxRoot('pluginsCommands'), 'p.ts'), 'pluginsCommands')).toBe(true);
    expect(isAllowedBoxSpecifier('../instanceLoader/fileConflictIndex', join(boxRoot('pluginsCommands'), 'p.ts'), 'pluginsCommands')).toBe(false);
    expect(isAllowedBoxSpecifier('../instanceLoader/instance', join(boxRoot('install'), 'p.ts'), 'install')).toBe(false);
  });
});

describe('the composition root reaches the Instance adapter through its interface', () => {
  it('scans the activation file and its wiring', () => {
    const files = rootFiles().map((path) => relative(SRC, path));
    expect(files).toEqual(expect.arrayContaining(['extension.ts', 'syncWiring.ts']));
    expect(files.filter((f) => f.startsWith('instanceAdapter'))).toEqual([]);
  });

  it('every root file imports only the adapter\'s interface, but where extension.ts constructs MO2\'s implementation', () => {
    expect(rootOffenders()).toEqual({});
  });

  it('refuses the adapter\'s layout, files and codecs from any root file, and its implementation outside the construction', () => {
    const extension = join(SRC, 'syncWiring.ts');
    expect(isAllowedRootSpecifier('./instanceAdapter/layout', extension)).toBe(false);
    expect(isAllowedRootSpecifier('./instanceAdapter/files', MO2_CONSTRUCTION.file)).toBe(false);
    expect(isAllowedRootSpecifier('./instanceAdapter/codecs/modlistText', MO2_CONSTRUCTION.file)).toBe(false);
    expect(isAllowedRootSpecifier('./instanceAdapter/mo2Instance', extension)).toBe(false);
    expect(isAllowedRootSpecifier('./instanceAdapter/mo2Instance', MO2_CONSTRUCTION.file)).toBe(true);
    expect(isAllowedRootSpecifier('./instanceAdapter/instanceAdapter', extension)).toBe(true);
  });
});
