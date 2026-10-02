import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ADR-0007: the webview writes through exactly one message, EDIT_FIELD, from one module. The host
// answers it by firing the edit field command, so the grid and the palette share one write path.
describe('the record editor webview writes through exactly one path', () => {
  const dir = __dirname;

  const sources = fs.readdirSync(dir)
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

  it('exactly one module posts the edit message, and it is the bridge', () => {
    // Positive control: the scan really reads real sources with real message usage in them.
    expect(sources).toContain('messages.ts');
    expect(sources.some((f) => read(f).includes('WEBVIEW_TO_EXTENSION'))).toBe(true);

    const posters = sources.filter((f) => f !== 'messages.ts' && /WEBVIEW_TO_EXTENSION\.EDIT_FIELD/.test(read(f)));
    expect(posters).toEqual(['nativeBridge.ts']);
  });
});
