import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * #410/ADR-0041: the record editor is a viewer. Editing is deliberately dead from this slice
 * until the text-first edit path returns (#415) — the backend endpoints every write below reached
 * are gone (S1), so an affordance that survived here would lead nowhere.
 *
 * Asserted against the client's own source rather than a rendered component: this is a statement
 * about what capability the webview *has*, and the surface that decides it is the one module every
 * write went through. Each absence assertion carries a positive control — the read methods that
 * must survive, found by the identical scan — so a renamed file or a failed read cannot pass as a
 * deletion.
 */
describe('the record editor webview has no write path (#410)', () => {
  const clientSrc = fs.readFileSync(
    path.join(__dirname, 'RecordSessionClient.ts'), 'utf8');

  const memberNames = [...clientSrc.matchAll(/^ {2}(\w+)\s*[(:]/gm)].map((m) => m[1]);

  it('RecordSessionClient exposes the read methods and no write method', () => {
    // Positive control, same scan: the reads the compare grid is built on are still declared.
    expect(memberNames).toContain('load');
    expect(memberNames).toContain('conditionRunOnTargets');

    const writes = ['save', 'revert', 'copyTo', 'removeOverride', 'copyAsNew',
      'groupMembers', 'saveGroup', 'revertGroup'];
    expect(writes.filter((w) => memberNames.includes(w))).toEqual([]);
  });

  it('no webview module still posts an edit message to the extension host', () => {
    const dir = __dirname;
    const sources = fs.readdirSync(dir)
      .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));

    // Positive control: the scan really reads real sources with real message usage in them.
    expect(sources).toContain('messages.ts');
    expect(sources.some((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('WEBVIEW_TO_EXTENSION'))).toBe(true);

    const RETIRED_MESSAGE = /PENDING_CHANGED|OPEN_REVERT_GROUP_CONFIRM|PENDING_CELL_|ARRAY_ADD|ARRAY_REMOVE|ARRAY_MOVE_|VMAD_ADD_|VMAD_REMOVE_|VMAD_SET_|VMAD_OPEN_ADD_PROPERTY|COLUMN_HEADER_|EXTENDED_EDITOR_/;
    const offenders = sources.filter((f) => RETIRED_MESSAGE.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
