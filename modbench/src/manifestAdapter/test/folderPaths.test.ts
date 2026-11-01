import { describe, expect, it } from 'vitest';
import type { FolderValue } from '../../repositoriesLib/statusValues';
import { exclusionsOf, isUnderAny } from '../manifestAdapter';

const holding = (paths: readonly string[], exclude: readonly string[] = []): Pick<FolderValue, 'files' | 'exclude'> => ({
  files: new Map(paths.map((path) => {
    const excluded = exclude.some((one) => path === one || path.startsWith(`${one}/`));
    return [excluded ? `${path}.mohidden` : path, { path, excluded, read: { kind: 'read', answer: { hash: 'H' } } }];
  })),
  exclude,
});

const EMPTY = holding([]);

describe('exclusionsOf', () => {
  it('keeps each exclusion the folder holds', () => {
    expect(exclusionsOf(undefined, holding(['a.esp', 'docs/readme.txt', 'b.esp'], ['a.esp', 'docs']))).toEqual(['a.esp', 'docs']);
  });

  it('keeps each exclusion the manifest records whose file the folder does not hold', () => {
    expect(exclusionsOf({ exclude: ['a.esp', 'docs'] }, EMPTY)).toEqual(['a.esp', 'docs']);
  });

  it('drops an exclusion the manifest records once the folder holds the file included', () => {
    expect(exclusionsOf({ exclude: ['a.esp'] }, holding(['a.esp']))).toEqual([]);
  });

  it('names a path the folder and the manifest both exclude once', () => {
    expect(exclusionsOf({ exclude: ['a.esp'] }, holding(['a.esp'], ['a.esp']))).toEqual(['a.esp']);
  });
});

describe('isUnderAny', () => {
  it.each([
    ['the path itself', ['a.esp'], 'a.esp', true],
    ['a folder above it', ['docs'], 'docs/a.txt', true],
    ['a path in another case, as a manifest names paths in their case', ['Docs'], 'docs/a.txt', false],
    ['a path its own begins with', ['docs'], 'docsx/a.txt', false],
  ])('matches %s: %s', (_case, exclude, path, excluded) => {
    expect(isUnderAny(exclude, path)).toBe(excluded);
  });
});
