import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { recordOpenIdentity } from '../recordPanelHost';

// plugins.md, Menus and keys: open to the side is on every record row, worldspaces, cells and
// placed references included. A row states its record structurally, as `recordIdentity` reads it.
describe('recordOpenIdentity — structural, not node-typed', () => {
  it('reads a RecordNode-shaped row', () => {
    expect(recordOpenIdentity({ kind: 'record', label: 'Gun [000801:A.esp]', record: { formKey: '000801:A.esp' } }))
      .toEqual({ formKey: '000801:A.esp', label: 'Gun [000801:A.esp]' });
  });

  it.each(['worldspace', 'cell', 'placed'])('reads a %s row by the FormKey it states', (kind) => {
    expect(recordOpenIdentity({ kind, label: 'Row', formKey: '000802:A.esp' }))
      .toEqual({ formKey: '000802:A.esp', label: 'Row' });
  });

  it('is undefined for a row that states no record', () => {
    expect(recordOpenIdentity({ kind: 'recordType', label: 'Weapon', plugin: 'A.esp' })).toBeUndefined();
  });
});
