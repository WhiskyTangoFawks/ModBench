import type { CompareResult } from '../client';
import type { Segment } from './sourceText';

type Field = CompareResult['overrides'][number]['fields'][number];
type FieldMetadata = Field['metadata'];

const valueAt = (record: unknown, path: Segment[]): unknown =>
  path.reduce((value, segment) => typeof value === 'object' && value !== null ? Reflect.get(value, segment) : undefined, record);

function memberOf(owner: Pick<FieldMetadata, 'fields'>, ownerValue: unknown, name: string): FieldMetadata | undefined {
  const member = owner.fields?.find((candidate) => candidate.name === name);
  const discriminator = owner.fields?.find((candidate) => candidate.isDiscriminator)?.name;
  const leaf = discriminator && valueAt(ownerValue, [discriminator]);
  return (typeof leaf === 'string' && member?.variants?.[leaf]) || member;
}

/** The metadata of the field at `path` of a record, from the fields mEdit answers for it; an object's
 *  members take the shape of the leaf its discriminator names. */
export function metadataAt(fields: Field[], record: unknown, path: Segment[]): FieldMetadata | undefined {
  let shape: Pick<FieldMetadata, 'fields'> = { fields: fields.map((field) => field.metadata) };
  let current: FieldMetadata | undefined;
  for (const [depth, segment] of path.entries()) {
    current = typeof segment === 'number' ? (current?.type === 'flags' ? current : current?.elementType) ?? undefined : memberOf(shape, valueAt(record, path.slice(0, depth)), segment);
    if (!current) return undefined;
    shape = current;
  }
  return current;
}
