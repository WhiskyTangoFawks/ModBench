import { findNodeAtLocation, parseTree, type Node } from 'jsonc-parser';

export interface TextSpan { start: number; end: number }

export const recordLabel = (editorId: string | null | undefined, formKey: string): string =>
  [editorId, `[${formKey}]`].filter(Boolean).join(' ');

export const ownFormKey = (node: Node): Node | undefined =>
  node.type === 'object' ? findNodeAtLocation(node, ['FormKey']) : undefined;

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
