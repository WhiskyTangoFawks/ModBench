import { findNodeAtLocation, findNodeAtOffset, getNodePath, getNodeValue, parseTree, type Node } from 'jsonc-parser';
import type { TextSpan } from '../symbolNames/symbolNames';

export type Segment = string | number;

export interface FieldAtOffset extends TextSpan {
  /** The nearest enclosing object with a `FormKey` member: a record, or a child record embedded in its owner's file. */
  recordFormKey: string;
  record: unknown;
  /** The members and indices from the record to the string value at the span. */
  path: Segment[];
}

const FORM_KEY = /^[0-9A-F]{6}[:_].+\.(esm|esp|esl)$/i;

// Mutagen reads either delimiter and either hex case as one FormKey; the Index names it by the colon and upper case.
const canonicalFormKey = (text: string): string => FORM_KEY.test(text) ? `${text.slice(0, 6).toUpperCase()}:${text.slice(7)}` : text;

const spanOf = (node: Node): TextSpan => ({ start: node.offset, end: node.offset + node.length });

const isStringValue = (node: Node): boolean =>
  node.type === 'string' && !(node.parent?.type === 'property' && node.parent.children?.[0] === node);

const ownFormKey = (node: Node): Node | undefined =>
  node.type === 'object' ? findNodeAtLocation(node, ['FormKey']) : undefined;

function find(node: Node, matches: (candidate: Node) => boolean): Node | undefined {
  if (matches(node)) return node;
  for (const child of node.children ?? []) {
    const found = find(child, matches);
    if (found) return found;
  }
  return undefined;
}

const stringNodeAt = (root: Node | undefined, offset: number): Node | undefined => {
  const node = root && findNodeAtOffset(root, offset);
  return node && isStringValue(node) ? node : undefined;
};

const isStringOf = (value: string) => (node: Node): boolean =>
  isStringValue(node) && typeof node.value === 'string' && canonicalFormKey(node.value) === canonicalFormKey(value);

const recordOf =(root: Node, formKey: string): Node | undefined =>
  find(root, (node) => {
    const own = ownFormKey(node);
    return own !== undefined && isStringOf(formKey)(own);
  });

/** The string value under `offset` with the record it sits in. */
export function fieldAt(text: string, offset: number): FieldAtOffset | undefined {
  const node = stringNodeAt(parseTree(text), offset);
  for (let ancestor = node?.parent; node && ancestor; ancestor = ancestor.parent) {
    const recordFormKey: unknown = ownFormKey(ancestor)?.value;
    if (typeof recordFormKey === 'string') {
      return { ...spanOf(node), recordFormKey: canonicalFormKey(recordFormKey), record: getNodeValue(ancestor), path: getNodePath(node).slice(getNodePath(ancestor).length) };
    }
  }
  return undefined;
}

// mEdit's field path is the document's own member names, an element's index in brackets.
export const locationOf = (fieldPath: string): Segment[] =>
  fieldPath.split('.').flatMap((member) => [member.split('[')[0] ?? member, ...[...member.matchAll(/\[(\d+)\]/g)].map((index) => Number(index[1]))]);

/** Each string the record `formKey` holds at one of `fieldPaths`, mEdit's member paths, by the span between its
 *  quotes. */
export function stringsAt(text: string, formKey: string, fieldPaths: readonly string[]): (TextSpan & { value: string })[] {
  const root = parseTree(text);
  const record = root && recordOf(root, formKey);
  if (!record) return [];
  return fieldPaths.flatMap((fieldPath) => {
    const node = findNodeAtLocation(record, locationOf(fieldPath));
    return node && isStringValue(node) && typeof node.value === 'string'
      ? [{ value: node.value, start: node.offset + 1, end: node.offset + node.length - 1 }]
      : [];
  });
}
