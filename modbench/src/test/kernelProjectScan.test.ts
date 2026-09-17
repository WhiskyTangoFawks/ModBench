// One composite project per box the diagram draws, a legacy project for what has not moved, and
// a root solution over both. The reference lists are the maintainer's, drawn in
// target-architecture-references.d2.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const MODBENCH = join(__dirname, '..', '..');

const KERNEL_BOXES = ['mo2Codecs', 'tables', 'wire', 'ports'];

// The driven column, each with the reference list target-architecture-references.d2 draws for it:
// the arrows that leave the box, plus its column's kernel by the band's rule.
const DRIVEN_BOXES: Record<string, string[]> = {
  mo2Files: ['mo2Codecs', 'ports', 'tables'],
  instance: ['mo2Codecs', 'mo2Files', 'ports', 'tables'],
};

// The core column, same rule. An arrow the diagram draws that the code has no use for is left
// out here and reported, never referenced to make the picture symmetric.
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

const REFERENCING_BOXES = { ...DRIVEN_BOXES, ...CORE_BOXES, ...VIEW_BOXES };

const BOXES = [...KERNEL_BOXES, ...Object.keys(REFERENCING_BOXES)];

const ROOT_SOLUTION = 'tsconfig.json';
const LEGACY_PROJECT = 'tsconfig.legacy.json';

const kernelProject = (box: string): string => join('src', box, 'tsconfig.json');

// TypeScript's own resolution of include, exclude and `extends`, so what is asserted is what the
// compiler builds, not the globs and the inheritance chain that happen to spell it.
function parsed(relativePath: string): ts.ParsedCommandLine {
  const path = join(MODBENCH, relativePath);
  const result = ts.getParsedCommandLineOfConfigFile(path, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, ' ')); },
  });
  if (!result) throw new Error(`No parsed command line for ${relativePath}`);
  return result;
}

const fileNames = (relativePath: string): string[] =>
  parsed(relativePath).fileNames.map((f) => relative(MODBENCH, f));

const referencePaths = (relativePath: string): string[] =>
  (parsed(relativePath).projectReferences ?? []).map((r) => relative(MODBENCH, r.path)).sort();

const testFiles = (box: string): string[] =>
  fileNames(kernelProject(box)).concat(fileNames(LEGACY_PROJECT))
    .filter((f) => f.startsWith(join('src', box) + '/') && f.includes('.test.'));

describe('one composite project per box', () => {
  it.each(BOXES)('%s has its own tsconfig', (box) => {
    expect(existsSync(join(MODBENCH, kernelProject(box)))).toBe(true);
  });

  // Composite is what lets another project reference it, and what lets `tsc -b` skip a box
  // whose inputs have not changed.
  it.each(BOXES)('%s is composite', (box) => {
    expect(parsed(kernelProject(box)).options.composite).toBe(true);
  });

  // The rule the compiler enforces: a kernel box references nothing, so a box that starts
  // needing another box fails `tsc -b` rather than compiling quietly.
  it.each(KERNEL_BOXES)('%s references nothing', (box) => {
    expect(referencePaths(kernelProject(box))).toEqual([]);
  });

  // `types: ["node"]` is the other half of the same rule: without it every @types package,
  // `@types/vscode` included, is ambient in a box the record panel also reads.
  it.each(KERNEL_BOXES)('%s sees the Node types and no others', (box) => {
    expect(parsed(kernelProject(box)).options.types).toEqual(['node']);
  });

  // MO2 files holds the one file system door, so the same rule binds it: a VS Code type here
  // would put the extension host behind that door.
  it('mo2Files sees the Node types and no others', () => {
    expect(parsed(kernelProject('mo2Files')).options.types).toEqual(['node']);
  });

  // The Instance owns every MO2-side watcher, and a watcher is VS Code's — the one driven box
  // that sees the extension host.
  it('instance sees the Node and VS Code types and no others', () => {
    expect(parsed(kernelProject('instance')).options.types).toEqual(['node', 'vscode']);
  });

  // A command writes through MO2 files and forgets, and the client is the one seam a tool
  // handler could call without an extension host: neither holds a host type.
  it.each(Object.keys(CORE_BOXES))('%s sees the Node types and no others', (box) => {
    expect(parsed(kernelProject(box)).options.types).toEqual(['node']);
  });

  // A view is a driving adapter onto VS Code's own trees, panels and palette — the one band
  // whose whole reason to exist is the extension host.
  it.each(Object.keys(VIEW_BOXES))('%s sees the Node and VS Code types', (box) => {
    expect(parsed(kernelProject(box)).options.types).toEqual(['node', 'vscode']);
  });

  // Rival this forbids: a view reaching a codec for a splice or a table for a game name, which
  // is what the Instance publishing the value it renders exists to make unnecessary.
  it.each(Object.keys(VIEW_BOXES))('%s references neither the codecs nor the tables', (box) => {
    expect(referencePaths(kernelProject(box)))
      .not.toEqual(expect.arrayContaining([join('src', 'mo2Codecs'), join('src', 'tables')]));
    expect(VIEW_BOXES[box]).not.toContain('mo2Codecs');
    expect(VIEW_BOXES[box]).not.toContain('tables');
  });

  // The rule the compiler enforces for the driven and core columns: each box references exactly
  // the arrows the diagram draws for it, so a new dependency fails `tsc -b` rather than
  // compiling quietly.
  it.each(Object.entries(REFERENCING_BOXES))('%s references exactly the boxes the diagram draws', (box, references) => {
    expect(referencePaths(kernelProject(box))).toEqual(references.map((r) => join('src', r)).sort());
  });

  it.each(BOXES)('%s emits outside src, so no build output lands beside a source file', (box) => {
    expect(relative(MODBENCH, parsed(kernelProject(box)).options.outDir ?? '')).toBe(join('out', 'projects', box));
  });

  it.each(BOXES)('%s compiles its own production files and no test', (box) => {
    const files = fileNames(kernelProject(box));
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.startsWith(join('src', box) + '/'))).toBe(true);
    expect(files.filter((f) => f.includes('.test.'))).toEqual([]);
  });
});

describe('the legacy project holds every file not yet moved', () => {
  it('references every box project, so an un-moved file still compiles against the boxes', () => {
    expect(referencePaths(LEGACY_PROJECT)).toEqual(BOXES.map((box) => join('src', box)).sort());
  });

  it('compiles the whole extension source tree', () => {
    expect(fileNames(LEGACY_PROJECT).length).toBeGreaterThan(150);
  });

  // A box's production file belongs to the box's own project and to no other, or the same
  // source would be typed twice and the reference would buy nothing.
  it.each(BOXES)('compiles none of %s’s production files', (box) => {
    const boxFiles = new Set(fileNames(kernelProject(box)));
    expect(fileNames(LEGACY_PROJECT).filter((f) => boxFiles.has(f))).toEqual([]);
  });

  // A box test may reach outside the kernel — the codecs' own tests read fixtures from disk —
  // so every one of them compiles here, and none inside the box's project.
  it.each(BOXES)('compiles every test that sits under %s', (box) => {
    expect(fileNames(LEGACY_PROJECT)).toEqual(expect.arrayContaining(testFiles(box)));
    expect(fileNames(kernelProject(box)).filter((f) => f.includes('.test.'))).toEqual([]);
  });

  // Rival: the codecs box holds eight of them, so a walk finding none would satisfy the
  // containment check above vacuously.
  it('finds the codecs box’s own tests', () => {
    expect(testFiles('mo2Codecs').length).toBeGreaterThan(5);
  });

  // The same vacuity, one level down: a view's tests sit under its own `test/`, and the legacy
  // project's per-box exclusion is a glob that would swallow one left beside the source.
  it.each(Object.keys(VIEW_BOXES))('finds %s’s own tests', (box) => {
    expect(testFiles(box).length).toBeGreaterThan(0);
  });
});

describe('the root solution builds every project', () => {
  it('references every box project and the legacy project, and nothing else', () => {
    expect(referencePaths(ROOT_SOLUTION))
      .toEqual([...BOXES.map((box) => join('src', box)), LEGACY_PROJECT].sort());
  });

  // A solution file lists projects, never sources: an empty file list is what stops `tsc -b`
  // compiling the tree twice, once through the solution and once through a project.
  it('compiles no file of its own', () => {
    expect(fileNames(ROOT_SOLUTION)).toEqual([]);
  });
});
