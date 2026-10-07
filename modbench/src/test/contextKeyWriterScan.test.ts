import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { tsFiles } from './tsFiles';
import { SRC } from './scanSource';

describe('each key has one writer', () => {
  const FOLDER_OWNERS = ['drivingLib/folderContext.ts', 'drivingLib/instanceCheck.ts'];
  const FIRST_READ_OWNERS = ['drivingLib/folderContext.ts', 'drivingLib/instanceFirstRead.ts'];
  const production = tsFiles(SRC, { exclude: ['generated', 'test'] });
  const naming = (pattern: RegExp) =>
    production.filter((path) => pattern.test(readFileSync(path, 'utf8'))).map((path) => relative(SRC, path));

  it('scans a real body of files', () => {
    expect(production.length).toBeGreaterThan(100);
  });

  it('names the folder key only where it is declared and written', () => {
    expect(naming(/\bFOLDER_KEY\b|modbench\.folder\b/).sort()).toEqual(FOLDER_OWNERS);
  });

  it('names the first-read key only where it is declared and written', () => {
    expect(naming(/\bINSTANCE_READ_KEY\b|modbench\.instanceRead\b/).sort()).toEqual(FIRST_READ_OWNERS);
  });

  it('marks the first read from the one place the Instance is built', () => {
    expect(naming(/\bmarkFirstReadLanded\(/).sort()).toEqual(['drivingLib/instanceFirstRead.ts', 'extension.ts']);
  });
});
