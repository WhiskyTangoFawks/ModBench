import { findNodeAtLocation, findNodeAtOffset, parseTree, type Node } from 'jsonc-parser';

export interface TextSpan { start: number; end: number }

export const recordLabel = (editorId: string | null | undefined, formKey: string): string =>
  [editorId, `[${formKey}]`].filter(Boolean).join(' ');

const FORM_KEY = /^[0-9A-F]{6}:.+$/i;

const isPropertyName = (node: Node): boolean => node.parent?.type === 'property' && node.parent.children?.[0] === node;

export const isStringValue = (node: Node, value?: string): boolean =>
  node.type === 'string' && !isPropertyName(node) && (value === undefined || node.value === value);

export const ownFormKey = (node: Node): Node | undefined =>
  node.type === 'object' ? findNodeAtLocation(node, ['FormKey']) : undefined;

export function stringAt(text: string, offset: number): Node | undefined {
  const root = parseTree(text);
  const node = root && findNodeAtOffset(root, offset);
  return node && isStringValue(node) ? node : undefined;
}

export function formKeyAt(text: string, offset: number): TextSpan & { formKey: string } | undefined {
  const node = stringAt(text, offset);
  const value: unknown = node?.value;
  return node && typeof value === 'string' && FORM_KEY.test(value)
    ? { formKey: value, start: node.offset, end: node.offset + node.length } : undefined;
}

export function findStringValue(node: Node, value: string): Node | undefined {
  if (isStringValue(node, value)) return node;
  for (const child of node.children ?? []) {
    const found = findStringValue(child, value);
    if (found) return found;
  }
  return undefined;
}

export function recordObject(node: Node, formKey: string): Node | undefined {
  if (ownFormKey(node)?.value === formKey) return node;
  for (const child of node.children ?? []) {
    const found = recordObject(child, formKey);
    if (found) return found;
  }
  return undefined;
}

export function formKeyMember(text: string, formKey: string): TextSpan | undefined {
  const root = parseTree(text);
  const record = root && recordObject(root, formKey);
  const member = record && ownFormKey(record)?.parent;
  return member && { start: member.offset, end: member.offset + member.length };
}
