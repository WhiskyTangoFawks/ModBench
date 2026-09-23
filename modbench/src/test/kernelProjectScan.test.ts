// One composite project per box, one for the composition root, one for the webview, a test
// project over every test, and a root solution over them all. The reference lists are the
// maintainer's, drawn in target-architecture-references.d2.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { tsFiles } from './tsFiles';

const MODBENCH = join(__dirname, '..', '..');

const KERNEL_BOXES = ['mo2Codecs', 'tables', 'wire', 'ports'];

// The driven column, each with the reference list target-architecture-references.d2 draws for it:
// the arrows that leave the box, plus its column's kernel by the band's rule.
const DRIVEN_BOXES: Record<string, string[]> = {
  instanceAdapter: ['mo2Codecs', 'ports', 'tables'],
  instanceLoader: ['mo2Codecs', 'instanceAdapter', 'ports', 'tables'],
};

// The core column, same rule. An arrow the diagram draws that the code has no use for is left
// out here and reported, never referenced to make the picture symmetric.
const CORE_BOXES: Record<string, string[]> = {
  modlist: ['mo2Codecs', 'instanceAdapter', 'ports'],
  pluginsCommands: ['instanceLoader', 'mo2Codecs', 'instanceAdapter', 'ports'],
  instanceCommands: ['mo2Codecs', 'instanceAdapter', 'ports'],
  install: ['mo2Codecs', 'instanceAdapter', 'ports'],
  client: ['ports', 'wire'],
};


// The driving band: each view reads a value and fires a command, with the reference list
// target-architecture-references.d2 draws for it.
const VIEW_BOXES: Record<string, string[]> = {
  mods: ['install', 'instanceLoader', 'modlist', 'ports'],
  downloads: ['install', 'instanceLoader', 'ports'],
  plugins: ['client', 'instanceLoader', 'pluginsCommands', 'ports'],
  editor: ['client', 'ports', 'wire'],
};

const REFERENCING_BOXES = { ...DRIVEN_BOXES, ...CORE_BOXES, ...VIEW_BOXES };

const BOXES = [...KERNEL_BOXES, ...Object.keys(REFERENCING_BOXES)];

const ROOT_SOLUTION = 'tsconfig.json';
// The composition root: the Toolbox and the activation file, which reference every box by
// definition (target-architecture-references.d2's reading).
const ROOT_PROJECT = join('src', 'tsconfig.json');
const TEST_PROJECT = 'tsconfig.test.json';
const WEBVIEW_PROJECT = join('webview', 'tsconfig.json');
const INTEGRATION_PROJECT = 'tsconfig.integration.json';

const boxProject = (box: string): string => join('src', box, 'tsconfig.json');

// Every project that holds production source, so a file's owner can be counted.
const PRODUCTION_PROJECTS = [...BOXES.map(boxProject), ROOT_PROJECT];

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

const isTest = (f: string): boolean => f.includes('.test.') || f.split('/').includes('test');

// Off the disk, not off a project's file list: a file belonging to no project is invisible to
// every list there is, which is the very state this has to catch.
const filesOnDisk = (dir: string): string[] =>
  tsFiles(join(MODBENCH, dir), { tsx: false }).map((f) => relative(MODBENCH, f));

const testFilesOnDisk = (dir: string): string[] => filesOnDisk(dir).filter((f) => f.endsWith('.test.ts'));

// The integration suite compiles in its own project against the real VS Code process.
const productionFilesOnDisk = (): string[] =>
  tsFiles(join(MODBENCH, 'src'), { tsx: false, includeTests: false, exclude: ['test'] })
    .map((f) => relative(MODBENCH, f));

describe('one composite project per box', () => {
  it.each(BOXES)('%s has its own tsconfig', (box) => {
    expect(existsSync(join(MODBENCH, boxProject(box)))).toBe(true);
  });

  // Composite is what lets another project reference it, and what lets `tsc -b` skip a box
  // whose inputs have not changed.
  it.each(BOXES)('%s is composite', (box) => {
    expect(parsed(boxProject(box)).options.composite).toBe(true);
  });

  // The rule the compiler enforces: a kernel box references nothing, so a box that starts
  // needing another box fails `tsc -b` rather than compiling quietly.
  it.each(KERNEL_BOXES)('%s references nothing', (box) => {
    expect(referencePaths(boxProject(box))).toEqual([]);
  });

  // `types: ["node"]` is the other half of the same rule: without it every @types package,
  // `@types/vscode` included, is ambient in a box the record panel also reads.
  it.each(KERNEL_BOXES)('%s sees the Node types and no others', (box) => {
    expect(parsed(boxProject(box)).options.types).toEqual(['node']);
  });

  // MO2 files holds the one file system door, so the same rule binds it: a VS Code type here
  // would put the extension host behind that door.
  it('instanceAdapter sees the Node types and no others', () => {
    expect(parsed(boxProject('instanceAdapter')).options.types).toEqual(['node']);
  });

  // The Instance owns every MO2-side watcher, and a watcher is VS Code's — the one driven box
  // that sees the extension host.
  it('instanceLoader sees the Node and VS Code types and no others', () => {
    expect(parsed(boxProject('instanceLoader')).options.types).toEqual(['node', 'vscode']);
  });

  // A command writes through MO2 files and forgets, and the client is the one seam a tool
  // handler could call without an extension host: neither holds a host type.
  it.each(Object.keys(CORE_BOXES))('%s sees the Node types and no others', (box) => {
    expect(parsed(boxProject(box)).options.types).toEqual(['node']);
  });

  // A view is a driving adapter onto VS Code's own trees, panels and palette — the one band
  // whose whole reason to exist is the extension host.
  it.each(Object.keys(VIEW_BOXES))('%s sees the Node and VS Code types', (box) => {
    expect(parsed(boxProject(box)).options.types).toEqual(['node', 'vscode']);
  });

  // Rival: a view reaching a codec for a splice or a table for a game name. Read off the
  // tsconfig on disk, one assertion per box, so either box alone fails it.
  it.each(Object.keys(VIEW_BOXES))('%s references neither the codecs nor the tables', (box) => {
    const references = referencePaths(boxProject(box));
    expect(references).not.toContain(join('src', 'mo2Codecs'));
    expect(references).not.toContain(join('src', 'tables'));
  });

  // The rule the compiler enforces for the driven and core columns: each box references exactly
  // the arrows the diagram draws for it, so a new dependency fails `tsc -b` rather than
  // compiling quietly.
  it.each(Object.entries(REFERENCING_BOXES))('%s references exactly the boxes the diagram draws', (box, references) => {
    expect(referencePaths(boxProject(box))).toEqual(references.map((r) => join('src', r)).sort());
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

  // The activation file and the Toolbox are the two composition roots, and the extension host
  // is what they compose onto.
  it('sees the Node and VS Code types', () => {
    expect(parsed(ROOT_PROJECT).options.types).toEqual(['node', 'vscode']);
  });

  it('references every box and nothing else', () => {
    expect(referencePaths(ROOT_PROJECT)).toEqual(BOXES.map((box) => join('src', box)).sort());
  });

  it('emits outside src', () => {
    expect(relative(MODBENCH, parsed(ROOT_PROJECT).options.outDir ?? '')).toBe(join('out', 'projects', 'root'));
  });

  // The two roots and the glue they share, and no file of any box.
  it('compiles the activation file, the Toolbox and no box file', () => {
    const files = fileNames(ROOT_PROJECT);
    expect(files).toContain(join('src', 'extension.ts'));
    expect(files).toContain(join('src', 'toolbox.ts'));
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

  // Rival: a file left outside every project's include, which no `tsc -b` ever reads.
  it('no production file on disk is outside every project', () => {
    expect(productionFilesOnDisk().filter((f) => !owners.has(f))).toEqual([]);
  });

  // Rival: one project's glob swallowing another's file, so the same source is typed twice and
  // the reference between them buys nothing.
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

  // A box test may reach outside the kernel — the codecs' own tests read fixtures from disk —
  // so every one of them compiles here, and none inside the box's project.
  it.each([...BOXES, 'medit'])('compiles every test on disk under %s', (dir) => {
    const compiled = new Set(fileNames(TEST_PROJECT));
    expect(testFilesOnDisk(join('src', dir)).filter((f) => !compiled.has(f))).toEqual([]);
  });

  // Rival: a walk finding no test under any box would satisfy every containment row above
  // vacuously; a kernel box such as ports may honestly hold none, so the count is over boxes.
  it('finds tests on disk under most boxes', () => {
    expect(BOXES.filter((box) => testFilesOnDisk(join('src', box)).length > 0).length).toBeGreaterThan(10);
  });

  // The integration suite is the one exception: it compiles in its own project, for Mocha and
  // the real extension host.
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
  // Composite with its own root is what makes an import of any other src/ path a TS6059 and a
  // TS6307 rather than a file the compiler quietly pulls in.
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
  it('references every box, the composition root, the test project and the webview, and nothing else', () => {
    expect(referencePaths(ROOT_SOLUTION))
      .toEqual([...BOXES.map((box) => join('src', box)), 'src', TEST_PROJECT, 'webview'].sort());
  });

  // A solution file lists projects, never sources: an empty file list is what stops `tsc -b`
  // compiling the tree twice, once through the solution and once through a project.
  it('compiles no file of its own', () => {
    expect(fileNames(ROOT_SOLUTION)).toEqual([]);
  });
});
