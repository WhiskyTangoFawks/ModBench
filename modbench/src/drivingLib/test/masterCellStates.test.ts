import { describe, expect, it } from 'vitest';
import { withMasterCellStates } from '../masterCellStates';
import type { components } from '../../wire/generated/api';

type CompareResult = components['schemas']['CompareResult'];
type FieldDiff = components['schemas']['FieldDiff'];

const copy = (plugin: string) => ({
  formKey: '000800:A.esp', plugin, origin: 'Data/', isWinner: false, fields: [], recordType: 'NPC_', isPartialForm: false, isInOverwrite: false, loadIndex: '00',
});
const diff = (d: Partial<FieldDiff> & Pick<FieldDiff, 'fieldName'>): FieldDiff => ({
  values: {}, winnerColumn: '', cellStates: {}, conflictAll: 'NoConflict', noWinner: false, ...d,
});
const compare = (plugins: string[], diffs: FieldDiff[]): CompareResult => ({
  overrides: plugins.map(copy), diffs, conflictAll: 'NoConflict', recordTypeName: 'NPC', stringsLanguage: 'English',
});

describe('the first column\'s cell states', () => {
  it('reads Master where it holds a value and mEdit stated no state, in a row and in the rows beneath it', () => {
    const answered = withMasterCellStates(compare(['A.esp', 'B.esp'], [
      diff({ fieldName: 'Name', values: { 'A.esp': 'x' }, cellStates: { 'B.esp': 'Override' }, children: [diff({ fieldName: 'Full', values: { 'A.esp': 'y' } })] }),
    ]));

    expect(answered.diffs[0]?.cellStates).toEqual({ 'A.esp': 'Master', 'B.esp': 'Override' });
    expect(answered.diffs[0]?.children?.[0]?.cellStates).toEqual({ 'A.esp': 'Master' });
  });

  it('reads OnlyOne when no other copy is compared', () => {
    const answered = withMasterCellStates(compare(['A.esp'], [diff({ fieldName: 'Name', values: { 'A.esp': 'x' } })]));

    expect(answered.diffs[0]?.cellStates).toEqual({ 'A.esp': 'OnlyOne' });
  });

  it.each<[string, FieldDiff]>([
    ['holds no value', diff({ fieldName: 'Name', values: { 'A.esp': null } })],
    ['has a state mEdit stated', diff({ fieldName: 'Name', values: { 'A.esp': 'x' }, cellStates: { 'A.esp': 'IdenticalToMaster' } })],
    ['is stated per focused column', diff({ fieldName: 'Name', values: { 'A.esp': 'x' }, cellStatesByFocus: { 'A.esp': {} } })],
  ])('leaves a cell that %s as it is', (_case, row) => {
    expect(withMasterCellStates(compare(['A.esp', 'B.esp'], [row])).diffs[0]).toEqual(row);
  });
});
