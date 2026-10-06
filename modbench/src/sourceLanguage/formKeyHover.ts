import { findNodeAtOffset, parseTree } from 'jsonc-parser';
import type { MEditClient } from '../client';

const FORM_KEY = /^[0-9A-F]{6}:.+$/i;

export interface SourceHover {
  start: number;
  end: number;
  markdown: string;
}

/** The hover over the FormKey string at `offset` of a plugin source document; undefined where
 *  there is no FormKey, or no active plugin holds it (its problem is on the Problems panel). */
export async function hoverAt(client: Pick<MEditClient, 'getComparison'>, text: string, offset: number): Promise<SourceHover | undefined> {
  const root = parseTree(text);
  const node = root && findNodeAtOffset(root, offset);
  if (node?.type !== 'string' || (node.parent?.type === 'property' && node.parent.children?.[0] === node)) return undefined;
  const formKey: unknown = node.value;
  if (typeof formKey !== 'string' || !FORM_KEY.test(formKey)) return undefined;
  const comparison = await client.getComparison(formKey);
  if (comparison === null) return undefined;
  const winner = comparison.overrides.find((copy) => copy.isWinner);
  const lines = [
    `\`${winner?.editorId ? `${winner.editorId} ` : ''}[${formKey}]\``,
    comparison.recordTypeName,
    ...(winner ? [`Winner: ${winner.plugin}`] : []),
  ];
  return { start: node.offset, end: node.offset + node.length, markdown: lines.join('\n\n') };
}
