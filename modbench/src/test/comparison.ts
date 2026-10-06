import type { CompareResult } from '../client';

type Override = CompareResult['overrides'][number];
export type Field = Override['fields'][number];
export type FieldMetadata = Field['metadata'];

export interface Copy { plugin: string; isWinner: boolean; editorId?: string | null; fields?: Field[] }

/** A field of the given shape; `value` is what the record holds there. */
export const fieldOf = (shape: Partial<FieldMetadata> & Pick<FieldMetadata, 'name' | 'type'>, value?: unknown): Field => ({
  metadata: {
    isArray: false, validFormKeyTypes: [], enumMembers: [], allowsNull: false, isDiscriminator: false, isRecordHeaderMember: false,
    isRecordFormKey: false, ignoredInConflicts: false, isVersionControlInfo1: false, isEditorId: false, holdsAlpha: false, ...shape,
  },
  value,
});

const override = (formKey: string, copy: Copy): Override => ({
  formKey, origin: 'Data', recordType: 'weap', isPartialForm: false, loadIndex: '00', isInOverwrite: false, fields: [], ...copy,
});

/** What mEdit answers for a record held in `copies`. */
export const comparisonOf = (formKey: string, copies: Copy[]): CompareResult => ({
  overrides: copies.map((copy) => override(formKey, copy)), diffs: [], conflictAll: 'OnlyOne', recordTypeName: 'Weapon',
});
