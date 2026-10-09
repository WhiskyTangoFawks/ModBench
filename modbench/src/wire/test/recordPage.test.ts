import { describe, it, expect } from 'vitest';
import { readRecordPageGlobals } from '../recordPage';

const place = { collapsedRows: [], collapsedColumns: [], focusedCell: null, scroll: { top: 0, left: 0 } };

describe('the globals a record page is given', () => {
  it('reads each as the host set it', () => {
    const columns = [{ formKey: '000001:A.esp', plugin: { name: 'A.esp', origin: 'Data/' } }];
    const failure = { failed: 'refused', refusal: 'No.' };
    expect(readRecordPageGlobals({
      mEditFormKey: '000001:A.esp', mEditColumns: columns, mEditViewState: place, mEditLoadError: failure,
    })).toEqual({ mEditFormKey: '000001:A.esp', mEditColumns: columns, mEditViewState: place, mEditLoadError: failure });
  });

  it('leaves out a global the host did not set', () => {
    expect(readRecordPageGlobals({ mEditFormKey: '000001:A.esp' })).toEqual({ mEditFormKey: '000001:A.esp' });
  });

  it.each([
    ['mEditFormKey', 7],
    ['mEditColumns', [{ formKey: '000001:A.esp', plugin: 'A.esp' }]],
    ['mEditViewState', { collapsedRows: [] }],
    ['mEditLoadError', { failed: 'exploded' }],
  ])('throws on %s of another shape', (name, value) => {
    expect(() => readRecordPageGlobals({ [name]: value })).toThrow(name);
  });
});
