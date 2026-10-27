import { describe, it, expect } from 'vitest';
import { shapeUnderOwner } from '../indexShape';
import type { FieldMetadata } from '../messages';

const target: FieldMetadata = {
  name: 'Target', type: 'formKey', isArray: false, validFormKeyTypes: ['REFR'], enumMembers: [], allowsNull: true,
  isDiscriminator: false, isRecordHeaderMember: false, isRecordFormKey: false, ignoredInConflicts: false,
  isVersionControlInfo1: false, isEditorId: false, holdsAlpha: false, isPlacedRotation: false, indexWhen: ['UseAliases', 'UsePackageData'],
};

describe('shapeUnderOwner', () => {
  it.each(['UseAliases', 'UsePackageData'])('is a number while its owner sets %s', (flag) => {
    expect(shapeUnderOwner(target, { [flag]: true })).toMatchObject({ type: 'int', validFormKeyTypes: [], allowsNull: false });
  });

  it('is the reference while its owner sets neither', () => {
    expect(shapeUnderOwner(target, { UseAliases: false })).toBe(target);
  });
});
