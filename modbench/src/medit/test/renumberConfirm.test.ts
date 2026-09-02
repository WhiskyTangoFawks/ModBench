import { describe, it, expect } from 'vitest';
import { renumberConfirmMessage } from '../renumberConfirm';

// #572 ruling 3: when every referencer is tracked, the cascade is automatic behind one up-front
// confirm stating the blast radius — "updates N references across M plugins". No referencers →
// no confirm at all (the simple rename #427 already covers).
describe('renumberConfirmMessage', () => {
  const ref = (formKey: string, plugin: string, fieldPath = 'F') =>
    ({ formKey, plugin, fieldPath, recordType: 'weap', editorId: null, origin: 'Data' });

  it('is null when nothing references the record', () => {
    expect(renumberConfirmMessage('000800:A.esp', '000900:A.esp', [])).toBeNull();
  });

  it('states the new FormKey and the distinct record/plugin counts', () => {
    const message = renumberConfirmMessage('000800:A.esp', '000900:A.esp', [
      ref('000001:B.esp', 'B.esp'),
      ref('000001:B.esp', 'B.esp', 'G'), // same record via a second field — one reference record
      ref('000002:C.esp', 'C.esp'),
    ]);
    expect(message).toContain('000900:A.esp');
    expect(message).toContain('2 referencing record(s)');
    expect(message).toContain('2 plugin(s)');
  });

  it('counts plugins case-insensitively', () => {
    const message = renumberConfirmMessage('000800:A.esp', '000900:A.esp', [
      ref('000001:B.esp', 'B.esp'),
      ref('000002:B.esp', 'b.ESP'),
    ]);
    expect(message).toContain('1 plugin(s)');
  });
});
