import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * #410/ADR-0041 wrote this as "the record editor is a viewer, and editing is dead until #415".
 * #415 arrived, so the framing is rewritten rather than the file deleted: what it was really
 * pinning — that the *pending-change* surface stayed retired — is still worth pinning, and is the
 * more interesting claim now, because there is once again a write path that the old shapes could
 * quietly grow back onto.
 *
 * The two things this file now says:
 *
 * 1. The webview writes through exactly one message, EDIT_FIELD, posted from exactly one module.
 *    Not through RecordSessionClient, which stays read-only — an edit travels webview → extension
 *    host → backend so that a refusal can become a native notification, a surface only the host has.
 * 2. None of the retired pending-change messages came back. Those were the staging model
 *    (retired by ADR-0041); a working-tree change is the only "pending" state that exists.
 *
 * Asserted against the sources rather than rendered components, because this is a statement about
 * what capability the webview *has*. Each absence assertion carries a positive control found by the
 * identical scan, so a renamed file or a failed read cannot pass as a deletion.
 */
describe('the record editor webview writes through exactly one path (#415)', () => {
  const dir = __dirname;
  const clientSrc = fs.readFileSync(path.join(dir, 'RecordSessionClient.ts'), 'utf8');
  const memberNames = [...clientSrc.matchAll(/^ {2}(\w+)\s*[(:]/gm)].map((m) => m[1]);

  const sources = fs.readdirSync(dir)
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

  it('RecordSessionClient stays read-only — the backend client is not the write path', () => {
    // Positive control, same scan: the reads the compare grid is built on are still declared.
    expect(memberNames).toContain('load');
    expect(memberNames).toContain('conditionRunOnTargets');

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

  // #426: EXTENDED_EDITOR_/ARRAY_*/VMAD_* are struck from this list one at a time as the gesture-
  // inventory ticket restores each — they were never pending-change concepts themselves, only
  // caught here because #410 retired everything on the old write path in one sweep (this ticket's
  // own commit history shows EXTENDED_EDITOR_ leaving the list the moment #426 Track 3 restored
  // it). Genuinely dead for good, because each *is* the pending-change/staging model itself
  // (retired by ADR-0041's working-tree model, which has no "pending" state to
  // stage into, no per-plugin Save button, and no whole-record column-header copy action of its
  // own): PENDING_CHANGED, OPEN_REVERT_GROUP_CONFIRM, PENDING_CELL_, COLUMN_HEADER_.
  //
  // Track 5 struck VMAD_OPEN_ADD_PROPERTY: Add Property's own dialog-open signal, restored
  // unchanged (same name, same "which script/plugin to open the dialog for" shape). VMAD_ADD_/
  // VMAD_REMOVE_/VMAD_SET_ stay blocked — those name the pre-#410 six-message-per-op design (one
  // message per structural op); Track 5's own design deliberately replaced that with a single
  // VMAD_STRUCTURAL_OP broadcast carrying an op-envelope value (messages.ts's own doc comment on
  // it), so a message matching one of those three prefixes reappearing would mean the old,
  // rejected shape crept back in, not that this ticket restored it.
  it('no retired pending-change message came back with the write path', () => {
    const RETIRED_MESSAGE = /PENDING_CHANGED|OPEN_REVERT_GROUP_CONFIRM|PENDING_CELL_|VMAD_ADD_|VMAD_REMOVE_|VMAD_SET_|COLUMN_HEADER_/;
    const offenders = sources.filter((f) => RETIRED_MESSAGE.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
