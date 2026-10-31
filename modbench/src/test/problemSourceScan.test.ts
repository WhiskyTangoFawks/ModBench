import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { tsFiles } from './tsFiles';
import { SRC } from './scanSource';

describe('each problem names Modbench as its source', () => {
  const production = tsFiles(SRC, { exclude: ['generated', 'test'] });

  it('scans a real body of files', () => {
    expect(production.length).toBeGreaterThan(100);
  });

  it('makes a Diagnostic only in modbenchDiagnostic', () => {
    const making = production.filter((path) => /new vscode\.Diagnostic\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).split(sep).join('/'));

    expect(making).toEqual(['drivingLib/modbenchDiagnostic.ts']);
  });
});
