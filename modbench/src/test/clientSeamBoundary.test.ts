import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { isTestSupport, SRC } from './scanSource';
import { tsFiles } from './tsFiles';

const CLIENT_DIR = 'client';
const GENERATED_DIR = 'generated';

function isClientFolder(relativePath: string): boolean {
  return relativePath.split(sep)[0] === CLIENT_DIR;
}

function streamPathNamers(root: string): string[] {
  return tsFiles(root)
    .map((path) => relative(root, path))
    .filter((relPath) => !relPath.split(sep).includes(GENERATED_DIR) && !isTestSupport(relPath) && !isClientFolder(relPath))
    .filter((relPath) => readFileSync(join(root, relPath), 'utf8').includes('/notifications/stream'));
}

describe('the notification stream path is the client box\'s alone', () => {
  it('walks a real body of files', () => {
    expect(tsFiles(SRC).length).toBeGreaterThan(150);
  });

  it('the tree as it stands names it nowhere else', () => {
    expect(streamPathNamers(SRC)).toEqual([]);
  });

  it('the client folder itself is excluded, not merely empty of offenses', () => {
    expect(isClientFolder(join('client', 'HttpMEditClient.ts'))).toBe(true);
  });

  it('a plant outside the client box is caught, and the same plant inside it is not', () => {
    const root = mkdtempSync(join(tmpdir(), 'medit-client-seam-boundary-'));
    try {
      mkdirSync(join(root, 'plugins'), { recursive: true });
      mkdirSync(join(root, 'client'), { recursive: true });
      writeFileSync(join(root, 'plugins', 'Provider.ts'), "export const path = '/notifications/stream';\n");
      writeFileSync(join(root, 'client', 'notificationStream.ts'), "export const path = '/notifications/stream';\n");
      expect(streamPathNamers(root)).toEqual([join('plugins', 'Provider.ts')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
