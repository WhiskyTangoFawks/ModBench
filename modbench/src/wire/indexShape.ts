import type { FieldMetadata } from './messages';

/** A member's shape under its owner: a link the owner says names an alias or package data
 *  (FieldMetadata.indexWhen) holds that index's number. */
export function shapeUnderOwner(shape: FieldMetadata, owner: unknown): FieldMetadata {
  const says = (flag: string) => typeof owner === 'object' && owner !== null && Reflect.get(owner, flag) === true;
  return shape.indexWhen?.some(says)
    ? { ...shape, type: 'int', validFormKeyTypes: [], allowsNull: false, indexWhen: null }
    : shape;
}
