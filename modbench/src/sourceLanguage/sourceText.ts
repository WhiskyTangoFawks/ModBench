import { findNodeAtLocation, findNodeAtOffset, getNodePath, getNodeValue, parseTree, type Node } from 'jsonc-parser';

export interface TextSpan { start: number; end: number }

export type Segment = string | number;

export interface FieldAtOffset extends TextSpan {
  /** The nearest enclosing object with a `FormKey` member: a record, or a child record embedded in its owner's file. */
  recordFormKey: string;
  record: unknown;
  /** The members and indices from the record to the string value at the span. */
  path: Segment[];
}

interface ProblemPlace {
  formKey?: string | null;
  targetFormKey?: string | null;
  fieldPath?: string | null;
}

const FORM_KEY = /^[0-9A-F]{6}:.+$/i;

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

const isStringOf = (value: string) => (node: Node): boolean => isStringValue(node) && node.value === value;

const recordOf = (root: Node, formKey: string): Node | undefined =>
  find(root, (node) => ownFormKey(node)?.value === formKey);

/** The FormKey string under `offset`, and its span. */
export function formKeyAt(text: string, offset: number): (TextSpan & { formKey: string }) | undefined {
  const node = stringNodeAt(parseTree(text), offset);
  const value: unknown = node?.value;
  return node && typeof value === 'string' && FORM_KEY.test(value) ? { formKey: value, ...spanOf(node) } : undefined;
}

/** The string value under `offset` with the record it sits in. */
export function fieldAt(text: string, offset: number): FieldAtOffset | undefined {
  const node = stringNodeAt(parseTree(text), offset);
  for (let ancestor = node?.parent; node && ancestor; ancestor = ancestor.parent) {
    const recordFormKey: unknown = ownFormKey(ancestor)?.value;
    if (typeof recordFormKey === 'string') {
      return { ...spanOf(node), recordFormKey, record: getNodeValue(ancestor), path: getNodePath(node).slice(getNodePath(ancestor).length) };
    }
  }
  return undefined;
}

/** The span of the `FormKey` member of the record `formKey` names. */
export function formKeyMember(text: string, formKey: string): TextSpan | undefined {
  const root = parseTree(text);
  const record = root && recordOf(root, formKey);
  const member = record && ownFormKey(record)?.parent;
  return member ? spanOf(member) : undefined;
}

const valuesOf = (node: Node): Node[] => (node.type === 'property' ? node.children?.slice(1) : node.children) ?? [];

// A nested object with a FormKey of its own is a child record, whose references are its own
// (editor-referenced-by.md, The tree, story 5).
function firstReference(record: Node, formKey: string): Node | undefined {
  const own = ownFormKey(record)?.parent;
  for (const child of valuesOf(record)) {
    if (child === own || ownFormKey(child) !== undefined) continue;
    const found = isStringOf(formKey)(child) ? child : firstReference(child, formKey);
    if (found) return found;
  }
  return undefined;
}

/** Where the record `referrer` references `formKey`: its first reference, else its own FormKey; the
 *  start of the text when the record is absent. */
export function referenceSpan(text: string, referrer: string, formKey: string): TextSpan {
  const root = parseTree(text);
  const record = root && recordOf(root, referrer);
  const found = record && (firstReference(record, formKey) ?? ownFormKey(record));
  return found ? spanOf(found) : { start: 0, end: 0 };
}

// mEdit's field path is the document's own member names, an element's index in brackets.
const locationOf = (fieldPath: string): Segment[] =>
  fieldPath.split('.').flatMap((member) => [member.split('[')[0] ?? member, ...[...member.matchAll(/\[(\d+)\]/g)].map((index) => Number(index[1]))]);

function stringInScope(scope: Node, spanned: string, fieldPath: string | null | undefined): Node | undefined {
  const atPath = fieldPath ? findNodeAtLocation(scope, locationOf(fieldPath)) : undefined;
  return atPath && isStringOf(spanned)(atPath) ? atPath : find(scope, isStringOf(spanned));
}

/** The span a problem sits on: the string of the FormKey it names at its field path, else the first
 *  such string in its record; undefined where the text holds none. */
export function problemSpan(text: string, { formKey, targetFormKey, fieldPath }: ProblemPlace): TextSpan | undefined {
  const root = parseTree(text);
  const scope = root && formKey ? (recordOf(root, formKey) ?? root) : root;
  const spanned = targetFormKey ?? formKey;
  const target = scope && spanned ? stringInScope(scope, spanned, fieldPath) : undefined;
  return target && spanOf(target);
}
