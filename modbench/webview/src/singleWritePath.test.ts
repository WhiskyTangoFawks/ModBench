import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('the record editor webview writes through exactly one message, EDIT_FIELD, from one module', () => {
  const dir = __dirname;

  const sources = fs.readdirSync(dir)
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

  it('the scan reads real sources with real message usage in them', () => {
    expect(sources.some((f) => read(f).includes('WEBVIEW_TO_EXTENSION'))).toBe(true);
  });

  it('exactly one module posts the edit message, and it is the bridge', () => {
    const posters = sources.filter((f) => /WEBVIEW_TO_EXTENSION\.EDIT_FIELD/.test(read(f)));
    expect(posters).toEqual(['nativeBridge.ts']);
  });
});
