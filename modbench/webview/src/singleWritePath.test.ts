import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ADR-0041: the webview writes through exactly one message, EDIT_FIELD, from one module — an
// edit travels through the extension host so a refusal can become a native notification, a
// surface only the host has.
describe('the record editor webview writes through exactly one path', () => {
  const dir = __dirname;
  const clientSrc = fs.readFileSync(path.join(dir, 'RecordPanelClient.ts'), 'utf8');
  const memberNames = [...clientSrc.matchAll(/^ {2}(\w+)\s*[(:]/gm)].map((m) => m[1]);

  const sources = fs.readdirSync(dir)
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

  it('RecordPanelClient stays read-only — the backend client is not the write path', () => {
    // Positive control, same scan: the reads the compare grid is built on are still declared.
    expect(memberNames).toContain('load');

    const writes = ['save', 'revert', 'copyTo', 'removeOverride', 'copyAsNew',
      'groupMembers', 'saveGroup', 'revertGroup', 'editField'];
    expect(writes.filter((w) => memberNames.includes(w))).toEqual([]);
  });

  it('exactly one module posts the edit message, and it is the bridge', () => {
    // Positive control: the scan really reads real sources with real message usage in them.
    expect(sources).toContain('messages.ts');
    expect(sources.some((f) => read(f).includes('WEBVIEW_TO_EXTENSION'))).toBe(true);

    const posters = sources.filter((f) => f !== 'messages.ts' && /WEBVIEW_TO_EXTENSION\.EDIT_FIELD/.test(read(f)));
    expect(posters).toEqual(['nativeBridge.ts']);
  });
});
