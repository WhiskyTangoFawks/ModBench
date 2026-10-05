import { describe, it, expect } from 'vitest';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { tsFiles } from './tsFiles';
import { BOXES, BOXES_BY_BAND, CORE_BOXES, DRIVING_BOXES, KERNEL_BOXES, PROJECT_FOLDERS, READ_MODEL_AND_REPOSITORY_BOXES, parseProject } from './boxes';

const MODBENCH = join(__dirname, '..', '..');

const ROOT_SOLUTION = 'tsconfig.json';
const ROOT_PROJECT = join('src', 'tsconfig.json');
const TEST_PROJECT = 'tsconfig.test.json';
const WEBVIEW_PROJECT = join('webview', 'tsconfig.json');
const INTEGRATION_PROJECT = 'tsconfig.integration.json';
const LINT_RULES = 'eslint-rules';

const boxProject = (box: string): string => join('src', box, 'tsconfig.json');

const PRODUCTION_PROJECTS = [...BOXES.map(boxProject), ROOT_PROJECT];

const parsed = (relativePath: string): ts.ParsedCommandLine => parseProject(join(MODBENCH, relativePath));

const fileNames = (relativePath: string): string[] =>
  parsed(relativePath).fileNames.map((f) => relative(MODBENCH, f));

const referencePaths = (relativePath: string): string[] =>
  (parsed(relativePath).projectReferences ?? []).map((r) => relative(MODBENCH, r.path)).sort();

const LIBS = Object.values(BOXES_BY_BAND).flatMap((band) => band
  .filter((box) => box.endsWith('Lib'))
  .map((lib) => ({ lib, band, users: BOXES.filter((box) => referencePaths(boxProject(box)).includes(join('src', lib))) })));

const isTest = (f: string): boolean => f.includes('.test.') || f.split('/').includes('test');

const filesOnDisk = (dir: string): string[] =>
  tsFiles(join(MODBENCH, dir), { tsx: false }).map((f) => relative(MODBENCH, f));

const testFilesOnDisk = (dir: string): string[] => filesOnDisk(dir).filter((f) => f.endsWith('.test.ts'));

const productionFilesOnDisk = (): string[] =>
  tsFiles(join(MODBENCH, 'src'), { tsx: false, includeTests: false, exclude: ['test'] })
    .map((f) => relative(MODBENCH, f));

describe('one composite project per box', () => {
  it('reads a real body of boxes off the zoom-out', () => {
    expect(BOXES.length).toBeGreaterThan(10);
  });

  it('every project folder on disk is a box the zoom-out draws', () => {
    expect(PROJECT_FOLDERS.filter((folder) => !BOXES.includes(folder))).toEqual([]);
  });

  it.each(BOXES)('%s is composite', (box) => {
    expect(parsed(boxProject(box)).options.composite).toBe(true);
  });

  it.each(KERNEL_BOXES)('%s references nothing', (box) => {
    expect(referencePaths(boxProject(box))).toEqual([]);
  });

  it.each(KERNEL_BOXES)('%s sees the Node types and no others', (box) => {
    expect(parsed(boxProject(box)).options.types).toEqual(['node']);
  });

  it.each(READ_MODEL_AND_REPOSITORY_BOXES)('%s sees the Node types and no others', (box) => {
    expect(parsed(boxProject(box)).options.types).toEqual(['node']);
  });

  it.each(CORE_BOXES)('%s sees the Node types and no others', (box) => {
    expect(parsed(boxProject(box)).options.types).toEqual(['node']);
  });

  it.each(DRIVING_BOXES)('%s sees the Node and VS Code types', (box) => {
    expect(parsed(boxProject(box)).options.types).toEqual(['node', 'vscode']);
  });

  it.each(DRIVING_BOXES)('%s references neither the codecs nor the tables', (box) => {
    const references = referencePaths(boxProject(box));
    expect(references).not.toContain(join('src', 'loadOrderFileCodec'));
    expect(references).not.toContain(join('src', 'tables'));
  });

  it.each(LIBS)('$lib is used by two or more boxes of its band, and by no other box', ({ users, band }) => {
    expect(users.length).toBeGreaterThanOrEqual(2);
    expect(users.filter((box) => !band.includes(box))).toEqual([]);
  });

  it.each(LIBS)('$lib references only boxes every box using it references', ({ lib, users }) => {
    const reachedByEveryUser = (reference: string) => users.every((box) => referencePaths(boxProject(box)).includes(reference));
    expect(referencePaths(boxProject(lib)).filter((reference) => !reachedByEveryUser(reference))).toEqual([]);
  });

  it.each(BOXES)('%s emits outside src, so no build output lands beside a source file', (box) => {
    expect(relative(MODBENCH, parsed(boxProject(box)).options.outDir ?? '')).toBe(join('out', 'projects', box));
  });

  it.each(BOXES)('%s compiles its own production files and no test', (box) => {
    const files = fileNames(boxProject(box));
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.startsWith(join('src', box) + '/'))).toBe(true);
    expect(files.filter(isTest)).toEqual([]);
  });
});

describe('the composition root is one project referencing every box', () => {
  it('is composite, so the test project compiles against its declarations', () => {
    expect(parsed(ROOT_PROJECT).options.composite).toBe(true);
  });

  it('sees the Node and VS Code types', () => {
    expect(parsed(ROOT_PROJECT).options.types).toEqual(['node', 'vscode']);
  });

  it('references every box and nothing else', () => {
    expect(referencePaths(ROOT_PROJECT)).toEqual(BOXES.map((box) => join('src', box)).sort());
  });

  it('emits outside src', () => {
    expect(relative(MODBENCH, parsed(ROOT_PROJECT).options.outDir ?? '')).toBe(join('out', 'projects', 'root'));
  });

  it('compiles the activation file, its wiring and no box file', () => {
    const files = fileNames(ROOT_PROJECT);
    expect(files).toContain(join('src', 'extension.ts'));
    expect(files).toContain(join('src', 'syncWiring.ts'));
    expect(files.filter(isTest)).toEqual([]);
    for (const box of BOXES) expect(files.filter((f) => f.startsWith(join('src', box) + '/'))).toEqual([]);
  });
});

describe('every production file belongs to exactly one project', () => {
  const owners = new Map<string, string[]>();
  for (const project of PRODUCTION_PROJECTS) {
    for (const file of fileNames(project)) owners.set(file, [...(owners.get(file) ?? []), project]);
  }

  it('walks a real body of production files', () => {
    expect(productionFilesOnDisk().length).toBeGreaterThan(100);
  });

  it('no production file on disk is outside every project', () => {
    expect(productionFilesOnDisk().filter((f) => !owners.has(f))).toEqual([]);
  });

  it('no production file is compiled by two projects', () => {
    expect([...owners].filter(([, projects]) => projects.length > 1).map(([f]) => f)).toEqual([]);
  });
});

describe('the test project holds every test and no production file', () => {
  it('references every production project, so a test compiles against the box it exercises', () => {
    expect(referencePaths(TEST_PROJECT)).toEqual(PRODUCTION_PROJECTS.map((p) => p.replace(/\/tsconfig\.json$/, '')).sort());
  });

  it('emits nothing', () => {
    expect(parsed(TEST_PROJECT).options.noEmit).toBe(true);
  });

  it.each(BOXES)('compiles every test on disk under %s', (dir) => {
    const compiled = new Set(fileNames(TEST_PROJECT));
    expect(testFilesOnDisk(join('src', dir)).filter((f) => !compiled.has(f))).toEqual([]);
  });

  it('finds tests on disk under most boxes', () => {
    expect(BOXES.filter((box) => testFilesOnDisk(join('src', box)).length > 0).length).toBeGreaterThan(10);
  });

  it('compiles every unit test under src/test, and none of the integration suite', () => {
    const compiled = new Set(fileNames(TEST_PROJECT));
    const integration = join('src', 'test', 'integration') + '/';
    const unit = testFilesOnDisk(join('src', 'test')).filter((f) => !f.startsWith(integration));
    expect(unit.length).toBeGreaterThan(10);
    expect(unit.filter((f) => !compiled.has(f))).toEqual([]);
    expect(fileNames(TEST_PROJECT).filter((f) => f.startsWith(integration))).toEqual([]);
    expect(fileNames(INTEGRATION_PROJECT).every((f) => f.startsWith(integration))).toBe(true);
  });

  it('compiles no production file', () => {
    const production = new Set(productionFilesOnDisk());
    expect(fileNames(TEST_PROJECT).filter((f) => production.has(f))).toEqual([]);
  });
});

describe('the webview references the wire box and nothing else in the extension', () => {
  it('is composite and rooted in its own directory', () => {
    expect(parsed(WEBVIEW_PROJECT).options.composite).toBe(true);
    expect(relative(MODBENCH, parsed(WEBVIEW_PROJECT).options.rootDir ?? '')).toBe('webview');
  });

  it('references only the wire box', () => {
    expect(referencePaths(WEBVIEW_PROJECT)).toEqual([join('src', 'wire')]);
  });

  it('compiles only its own sources', () => {
    const files = fileNames(WEBVIEW_PROJECT);
    expect(files.length).toBeGreaterThan(10);
    expect(files.every((f) => f.startsWith(join('webview', 'src') + '/'))).toBe(true);
  });
});

describe('the root solution builds every project', () => {
  it('references every box, the composition root, the test project, the webview and the lint rules, and nothing else', () => {
    expect(referencePaths(ROOT_SOLUTION))
      .toEqual([...BOXES.map((box) => join('src', box)), 'src', TEST_PROJECT, 'webview', LINT_RULES].sort());
  });

  it('compiles no file of its own', () => {
    expect(fileNames(ROOT_SOLUTION)).toEqual([]);
  });
});
