import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { importSpecifiers, isTestSupport, SRC } from './scanSource';
import { tsFiles } from './tsFiles';

const CLIENT_DIR = 'client';
const GENERATED_DIR = 'generated';

const importsOf = (source: string): string[] => importSpecifiers(source, 'source.ts');

function isClientFolder(relativePath: string): boolean {
  return relativePath.split(sep)[0] === CLIENT_DIR;
}

const GENERATED_TYPE_ONLY_EXCEPTIONS = [join('wire', 'messages.ts'), join('wire', 'pluginAddress.ts'), join('wire', 'wireContractChecks.ts')];

interface Offense { path: string; reason: string }

function findOffenders(root: string): Offense[] {
  const offenses: Offense[] = [];
  for (const path of tsFiles(root)) {
    const relPath = relative(root, path);
    if (relPath.split(sep).includes(GENERATED_DIR)) continue;
    if (isTestSupport(relPath)) continue;
    if (isClientFolder(relPath)) continue;

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

    it('the same generated-client and openapi-fetch imports, planted inside the client box, are not caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'client'), { recursive: true });
        writeFileSync(
          join(root, 'client', 'apiClient.ts'),
          "import type { components } from '../generated/api';\nimport createClient from 'openapi-fetch';\n",
        );
        expect(findOffenders(root)).toEqual([]);
      });
    });
  });
});

describe('the port has exactly two adapters', () => {
  function classesImplementing(text: string): boolean {
    return /\bimplements MEditClient\b/.test(text);
  }

  const THIS_FILE_QUOTING_THE_PATTERN = join('test', 'clientSeamBoundary.test.ts');

  function classDeclarers(root: string): string[] {
    return tsFiles(root)
      .map((path) => relative(root, path))
      .filter((relPath) => !isClientFolder(relPath) && relPath !== THIS_FILE_QUOTING_THE_PATTERN)
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
