import { findNodeAtOffset, parseTree, type Node } from 'jsonc-parser';
import type { CompareResult, MEditClient } from '../client';

const FORM_KEY = /^[0-9A-F]{6}:.+$/i;

export interface SourceHover {
  start: number;
  end: number;
  markdown: string;
}

const isPropertyName = (node: Node): boolean => node.parent?.type === 'property' && node.parent.children?.[0] === node;

interface FormKeyString { formKey: string; start: number; end: number }

function formKeyAt(text: string, offset: number): FormKeyString | undefined {
  const root = parseTree(text);
  const node = root && findNodeAtOffset(root, offset);
  const value: unknown = node?.value;
  return node && typeof value === 'string' && node.type === 'string' && !isPropertyName(node) && FORM_KEY.test(value)
    ? { formKey: value, start: node.offset, end: node.offset + node.length } : undefined;
}

function markdownOf(formKey: string, comparison: CompareResult): string {
  const winner = comparison.overrides.find((copy) => copy.isWinner);
  return [
    '`' + [winner?.editorId, '[' + formKey + ']'].filter(Boolean).join(' ') + '`',
    comparison.recordTypeName,
    ...(winner ? [`Winner: ${winner.plugin}`] : []),
  ].join('\n\n');
}

/** The hover over the FormKey string at `offset` of a plugin source document; undefined where
 *  there is no FormKey, or no active plugin holds it (its problem is on the Problems panel). */
export async function hoverAt(client: Pick<MEditClient, 'getComparison'>, text: string, offset: number): Promise<SourceHover | undefined> {
  const found = formKeyAt(text, offset);
  const comparison = found && await client.getComparison(found.formKey);
  return found && comparison ? { start: found.start, end: found.end, markdown: markdownOf(found.formKey, comparison) } : undefined;
}
