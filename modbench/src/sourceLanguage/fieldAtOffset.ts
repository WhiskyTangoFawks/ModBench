import { findNodeAtLocation, findNodeAtOffset, getNodePath, parseTree, type Node, type Segment } from 'jsonc-parser';
import type { CompareResult } from '../client';

type Field = CompareResult['overrides'][number]['fields'][number];
type FieldMetadata = Field['metadata'];

export interface FieldAtOffset {
  /** The string value under the cursor. */
  node: Node;
  /** The nearest enclosing object with a `FormKey` member: a record, or a child record embedded in its owner's file. */
  record: Node;
  recordFormKey: string;
  /** The members and indices from `record` to `node`. */
  path: Segment[];
}

const isPropertyName = (node: Node): boolean => node.parent?.type === 'property' && node.parent.children?.[0] === node;

function recordAbove(node: Node): { record: Node; formKey: string } | undefined {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    const formKey: unknown = ancestor.type === 'object' ? findNodeAtLocation(ancestor, ['FormKey'])?.value : undefined;
    if (typeof formKey === 'string') return { record: ancestor, formKey };
  }
  return undefined;
}

/** The field of a record that a string value at `offset` of a plugin source document sits in. */
export function fieldAtOffset(text: string, offset: number): FieldAtOffset | undefined {
  const root = parseTree(text);
  const node = root && findNodeAtOffset(root, offset);
  if (!node || node.type !== 'string' || isPropertyName(node)) return undefined;
  const owner = recordAbove(node);
  return owner && { node, record: owner.record, recordFormKey: owner.formKey, path: getNodePath(node).slice(getNodePath(owner.record).length) };
}

function memberOf(owner: Pick<FieldMetadata, 'fields'>, ownerNode: Node | undefined, name: string): FieldMetadata | undefined {
  const member = owner.fields?.find((candidate) => candidate.name === name);
  const discriminator = owner.fields?.find((candidate) => candidate.isDiscriminator)?.name;
  const leaf: unknown = ownerNode && discriminator ? findNodeAtLocation(ownerNode, [discriminator])?.value : undefined;
  return (typeof leaf === 'string' && member?.variants?.[leaf]) || member;
}

/** The metadata of the field at `path` of a record, from the fields mEdit answers for it; an object's
 *  members take the shape of the leaf its discriminator names. */
export function metadataAt(fields: Field[], record: Node, path: Segment[]): FieldMetadata | undefined {
  let shape: Pick<FieldMetadata, 'fields'> = { fields: fields.map((field) => field.metadata) };
  let current: FieldMetadata | undefined;
  for (const [depth, segment] of path.entries()) {
    current = typeof segment === 'number' ? current?.elementType ?? undefined : memberOf(shape, findNodeAtLocation(record, path.slice(0, depth)), segment);
    if (!current) return undefined;
    shape = current;
  }
  return current;
}
