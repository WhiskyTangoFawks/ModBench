import type { CompareResult } from '../client';

export interface Copy { plugin: string; isWinner: boolean; editorId?: string | null }

const override = (formKey: string, copy: Copy): CompareResult['overrides'][number] => ({
  formKey, fields: [], origin: 'Data', recordType: 'weap', isPartialForm: false, loadIndex: '00', isInOverwrite: false, ...copy,
});

/** What mEdit answers for a record held in `copies`. */
export const comparisonOf = (formKey: string, copies: Copy[]): CompareResult => ({
  overrides: copies.map((copy) => override(formKey, copy)), diffs: [], conflictAll: 'OnlyOne', recordTypeName: 'Weapon',
});
