import { describe, it, expect, vi } from 'vitest';

import { makeOnRecordEdited } from '../onRecordEdited';

// The native Source Control panel does not pick up a field edit's working-tree dirt on its own;
// this is the wiring that closes that gap. The records and their badges follow mEdit's rows.
describe('makeOnRecordEdited', () => {
  it('refreshes Source Control for the edited plugin on every edit', () => {
    const refreshSourceControl = vi.fn();
    const onRecordEdited = makeOnRecordEdited(refreshSourceControl);

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(refreshSourceControl).toHaveBeenCalledTimes(1);
    expect(refreshSourceControl).toHaveBeenCalledWith('Test.esp', 'SomeMod');
  });
});
