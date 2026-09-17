import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { present } from '../ports/present';
import { tsFiles } from './tsFiles';

// ADR-0002/ADR-0014: the generated client, `openapi-fetch`, `undici` and the notification
// stream's endpoint path live only under the client box. The webview calls the backend
// directly (RecordPanelClient.ts, ADR-0007) but sits outside modbench/src.

const SRC = join(__dirname, '..');
const CLIENT_DIR = 'client';
const GENERATED_DIR = 'generated';

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:import|export)[\s\S]*?from\s+'([^']+)'/g)].map((m) => present(m[1], "the import/export statement's module specifier"));
}

function isTestSupport(relativePath: string): boolean {
  return relativePath.split(sep).some((seg) => seg === 'test' || seg === 'integration') || relativePath.includes('.test.');
}

function isClientFolder(relativePath: string): boolean {
  return relativePath.split(sep)[0] === CLIENT_DIR;
}

// Pre-existing, narrow, type-only reads of the generated schema, neither the HTTP adapter: the
// webview wire protocol and the load-failure report. Named so this fold stays the five modules
// the ticket lists.
const GENERATED_TYPE_ONLY_EXCEPTIONS = [join('wire', 'messages.ts'), join('medit', 'pluginFailures.ts')];

interface Offense { path: string; reason: string }

function findOffenders(root: string): Offense[] {
  const offenses: Offense[] = [];
  for (const path of tsFiles(root)) {
    const relPath = relative(root, path);
    if (relPath.split(sep).includes(GENERATED_DIR)) continue; // the schema mirror itself
    if (isTestSupport(relPath)) continue; // fixtures and doubles, not production wiring
    if (isClientFolder(relPath)) continue; // the seam itself

    const text = readFileSync(path, 'utf8');
    const imports = importsOf(text);

    if (imports.some((s) => s.split('/').includes(GENERATED_DIR)) && !GENERATED_TYPE_ONLY_EXCEPTIONS.includes(relPath)) {
      offenses.push({ path: relPath, reason: 'imports the generated client outside the client box' });
    }
    if (imports.includes('openapi-fetch')) offenses.push({ path: relPath, reason: 'imports openapi-fetch outside the client box' });
    if (imports.includes('undici')) offenses.push({ path: relPath, reason: 'imports undici outside the client box' });
    if (text.includes('/notifications/stream')) {
      offenses.push({ path: relPath, reason: 'names the notification stream path outside the client box' });
    }
    // Never a dotted call (`x.fetch(...)`), an identifier merely containing "fetch"
    // (`undiciFetch(...)`), or a local `fetch` parameter/variable shadowing the global.
    const declaresLocalFetch = /[(,]\s*fetch\s*[,):]/.test(text) || /\b(?:const|let|var)\s+fetch\b/.test(text);
    if (!declaresLocalFetch && /(?<![.\w])fetch\(/.test(text)) {
      offenses.push({ path: relPath, reason: 'calls fetch outside the client box' });
    }
  }
  return offenses;
}

describe('the HTTP adapter is the one seam that speaks to the backend', () => {
  it('walks a real body of files', () => {
    expect(tsFiles(SRC).length).toBeGreaterThan(150);
  });

  it('the tree as it stands has no offenders', () => {
    expect(findOffenders(SRC)).toEqual([]);
  });

  it('the client folder itself is excluded, not merely empty of offenses', () => {
    expect(isClientFolder(join('client', 'HttpMEditClient.ts'))).toBe(true);
  });

  describe('a plant in each shape is caught, and the same plant inside the client box is not', () => {
    function withPlantedTree(run: (root: string) => void): void {
      const root = mkdtempSync(join(tmpdir(), 'medit-client-seam-boundary-'));
      try {
        run(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    it('a generated-client import planted under Plugins is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'plugins'), { recursive: true });
        writeFileSync(join(root, 'plugins', 'SomeProvider.ts'), "import type { components } from '../wire/generated/api';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('plugins', 'SomeProvider.ts')]);
      });
    });

    it('a generated-client import planted under Editor is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'editor'), { recursive: true });
        writeFileSync(join(root, 'editor', 'someCommand.ts'), "import type { components } from '../wire/generated/api';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('editor', 'someCommand.ts')]);
      });
    });

    it('a generated-client import planted under Mod Management is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'modmanager'), { recursive: true });
        writeFileSync(join(root, 'modmanager', 'ModListProvider.ts'), "import type { components } from '../wire/generated/api';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('modmanager', 'ModListProvider.ts')]);
      });
    });

    it('a raw fetch call planted outside the client box is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'plugins'), { recursive: true });
        writeFileSync(
          join(root, 'plugins', 'SomeProvider.ts'),
          "export async function read() { return fetch('http://localhost:5172/plugins'); }\n",
        );
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('plugins', 'SomeProvider.ts')]);
      });
    });

    // The rival this guards: a local variable or parameter merely named `fetch` (e.g. a generic
    // load callback) must not read as the backend seam.
    it('a local variable named fetch, called as a callback, is not caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'plugins'), { recursive: true });
        writeFileSync(
          join(root, 'plugins', 'SomeProvider.ts'),
          'async function getOrLoad(fetch) { return fetch(); }\n',
        );
        expect(findOffenders(root)).toEqual([]);
      });
    });

    it('the same generated-client import and fetch call, planted inside the client box, are not caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'client'), { recursive: true });
        writeFileSync(
          join(root, 'client', 'apiClient.ts'),
          "import type { components } from '../generated/api';\nimport createClient from 'openapi-fetch';\n"
          + "function f() { return fetch('http://localhost:5172/plugins'); }\n",
        );
        expect(findOffenders(root)).toEqual([]);
      });
    });
  });
});

// The proof-of-done's third clause: the in-memory adapter is the only fake in editing tests —
// walked into test folders too, exactly where a rival fake would live.
describe('the port has exactly two adapters', () => {
  function classesImplementing(text: string): boolean {
    return /\bimplements MEditClient\b/.test(text);
  }

  // This file's own source quotes the pattern it looks for (the regex above, the fixtures
  // below) — its own unavoidable false positive, allowlisted by name, not by folder.
  const SELF = join('test', 'clientSeamBoundary.test.ts');

  function classDeclarers(root: string): string[] {
    return tsFiles(root)
      .map((path) => relative(root, path))
      .filter((relPath) => !isClientFolder(relPath) && relPath !== SELF)
      .filter((relPath) => classesImplementing(readFileSync(join(root, relPath), 'utf8')));
  }

  it('walks a real body of files', () => {
    expect(tsFiles(SRC).length).toBeGreaterThan(150);
  });

  it('nothing outside the client box declares a class implementing MEditClient', () => {
    expect(classDeclarers(SRC)).toEqual([]);
  });

  it('the client box itself declares exactly HttpMEditClient and InMemoryMEditClient', () => {
    const declarers = tsFiles(join(SRC, CLIENT_DIR))
      .filter((path) => classesImplementing(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).split(sep).pop());
    expect(declarers.sort()).toEqual(['HttpMEditClient.ts', 'InMemoryMEditClient.ts']);
  });

  // Planted inside a test folder, not production code: proves the walk now reaches there too.
  it('a planted third adapter, inside a test folder, is caught', () => {
    const root = mkdtempSync(join(tmpdir(), 'medit-client-second-adapter-'));
    try {
      mkdirSync(join(root, 'plugins', 'test'), { recursive: true });
      writeFileSync(join(root, 'plugins', 'test', 'FakeClient.ts'), 'export class FakeClient implements MEditClient {}\n');
      expect(classDeclarers(root)).toEqual([join('plugins', 'test', 'FakeClient.ts')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
