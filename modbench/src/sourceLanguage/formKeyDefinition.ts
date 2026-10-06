import { findNodeAtLocation, parseTree, type Node } from 'jsonc-parser';

export interface TextSpan { start: number; end: number }

function ownMember(node: Node, formKey: string): Node | undefined {
  const value = node.type === 'object' ? findNodeAtLocation(node, ['FormKey']) : undefined;
  if (value?.value === formKey) return value.parent;
  for (const child of node.children ?? []) {
    const found = ownMember(child, formKey);
    if (found) return found;
  }
  return undefined;
}

/** The `FormKey` member of the object that is the record in a plugin source document: the
 *  document's own record, or a child record embedded in its owner's file. */
export function formKeyMember(text: string, formKey: string): TextSpan | undefined {
  const root = parseTree(text);
  const member = root && ownMember(root, formKey);
  return member && { start: member.offset, end: member.offset + member.length };
}
