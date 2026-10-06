import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { importSpecifiers, MO2_CONSTRUCTION as MO2_CONSTRUCTION_SITE, productionFiles, rootFiles, SRC } from './scanSource';
import { BOXES, CORE_BOXES, DRIVING_BOXES, KERNEL_BOXES, REFERENCING_BOXES } from './boxes';

const boxRoot = (box: string): string => join(SRC, box);

const FS_SPECIFIERS = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);

const PACKAGE_IMPORTERS = new Set(['client', 'sourceLanguage']);

const ADAPTER_WATCH = join(boxRoot('instanceAdapter'), 'mo2Watch.ts');

const isIn = (root: string, path: string): boolean => path === root || path.startsWith(root + '/');

const ADAPTER_INTERFACE = join(boxRoot('instanceAdapter'), 'instanceAdapter');

function isAllowedBoxSpecifier(spec: string, fromFile: string, box: string): boolean {
  if (KERNEL_BOXES.includes(box) && FS_SPECIFIERS.has(spec)) return false;
  if (spec.startsWith('node:')) return true;
  if (spec === 'vscode') return DRIVING_BOXES.includes(box) || fromFile === ADAPTER_WATCH;
  if (!spec.startsWith('.')) return PACKAGE_IMPORTERS.has(box);
  const resolved = resolve(dirname(fromFile), spec);
  if (box !== 'instanceAdapter' && isIn(boxRoot('instanceAdapter'), resolved)) return resolved === ADAPTER_INTERFACE;
  return true;
}

function disallowedSpecifiers(path: string, box: string): string[] {
  return importSpecifiers(readFileSync(path, 'utf8'), path).filter((spec) => !isAllowedBoxSpecifier(spec, path, box));
}

function boxOffenders(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const box of BOXES) {
    for (const path of productionFiles(boxRoot(box))) {
      const bad = disallowedSpecifiers(path, box);
      if (bad.length > 0) found[relative(SRC, path)] = bad;
    }
  }
  return found;
}

const MO2_CONSTRUCTION = { file: join(SRC, MO2_CONSTRUCTION_SITE.file), module: join(SRC, MO2_CONSTRUCTION_SITE.module) };

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

async function plantedKernelSpecifiers(source: string): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), 'medit-kernel-import-scan-'));
  try {
    const planted = join(root, 'planted.ts');
    await writeFile(planted, source);
    return disallowedSpecifiers(planted, KERNEL_BOXES[0] ?? '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('what a box may import beyond its reference list, which the build holds', () => {
  it('every box is a real directory holding production files', () => {
    for (const box of BOXES) {
      expect(existsSync(boxRoot(box))).toBe(true);
      expect(productionFiles(boxRoot(box)).length).toBeGreaterThan(0);
    }
  });

  it('every production file imports only what its box may', () => {
    expect(boxOffenders()).toEqual({});
  });

  it('flags a vscode import planted in a kernel module', async () => {
    expect(await plantedKernelSpecifiers("import * as vscode from 'vscode';\n")).toEqual(['vscode']);
  });

  it('flags a node:fs or node:fs/promises import planted in a kernel module', async () => {
    expect(await plantedKernelSpecifiers("import { readFile } from 'node:fs/promises';\nimport { existsSync } from 'node:fs';\n"))
      .toEqual(['node:fs/promises', 'node:fs']);
  });

  it('allows node:path, which a pure path function needs', async () => {
    expect(await plantedKernelSpecifiers("import { join } from 'node:path';\n")).toEqual([]);
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

  it('allows a package only in the client and the Source language', () => {
    expect(isAllowedBoxSpecifier('openapi-fetch', join(boxRoot('client'), 'p.ts'), 'client')).toBe(true);
    expect(isAllowedBoxSpecifier('jsonc-parser', join(boxRoot('sourceLanguage'), 'p.ts'), 'sourceLanguage')).toBe(true);
    expect(isAllowedBoxSpecifier('openapi-fetch', join(boxRoot('install'), 'p.ts'), 'install')).toBe(false);
  });

  it('allows vscode in every driving box', () => {
    for (const box of DRIVING_BOXES) {
      expect(isAllowedBoxSpecifier('vscode', join(boxRoot(box), 'p.ts'), box)).toBe(true);
    }
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

  it('allows the interface of the adapter, and node:fs outside the kernel', () => {
    expect(isAllowedBoxSpecifier('../instanceAdapter/instanceAdapter', join(boxRoot('instanceLoader'), 'p.ts'), 'instanceLoader')).toBe(true);
    expect(isAllowedBoxSpecifier('node:fs/promises', join(boxRoot('instanceAdapter'), 'p.ts'), 'instanceAdapter')).toBe(true);
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
