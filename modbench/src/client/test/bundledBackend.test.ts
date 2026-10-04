import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { bundledBackendPath } from '../bundledBackend';

describe('bundledBackendPath', () => {
  it('names the .exe on win32', () => {
    expect(bundledBackendPath('win32', join('x', 'out'))).toBe(join('x', 'backend', 'MEditService.Http.exe'));
  });

  it('names the bare binary on linux', () => {
    expect(bundledBackendPath('linux', join('x', 'out'))).toBe(join('x', 'backend', 'MEditService.Http'));
  });
});
