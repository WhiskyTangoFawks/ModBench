import { parseTree, type Node } from 'jsonc-parser';
import type { MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { pluginAddressOf } from '../wire/pluginAddress';
import type { RecordCopy } from '../drivingLib/recordDocument';
import { formKeyAt } from './formKeyHover';
import { locateCopies, type RecordLocation, type RecordLocationDeps } from './recordLocation';
import { ownFormKey, recordObject, type TextSpan } from './recordText';

const valuesOf = (node: Node): Node[] => (node.type === 'property' ? node.children?.slice(1) : node.children) ?? [];

function firstReference(node: Node, formKey: string): Node | undefined {
  const own = ownFormKey(node)?.parent;
  for (const child of valuesOf(node)) {
    // A nested object with a FormKey of its own is a child record, whose references are its own
    // (editor-referenced-by.md, The tree, story 5).
    if (child === own || ownFormKey(child) !== undefined) continue;
    if (child.type === 'string' && child.value === formKey) return child;
    const found = firstReference(child, formKey);
    if (found) return found;
  }
  return undefined;
}

function referenceSpan(text: string, referrer: string, formKey: string): TextSpan {
  const root = parseTree(text);
  const record = root && recordObject(root, referrer);
  const found = record && (firstReference(record, formKey) ?? ownFormKey(record));
  return found ? { start: found.offset, end: found.offset + found.length } : { start: 0, end: 0 };
}

export interface ReferencesDeps<Document> extends RecordLocationDeps<Document> {
  client: RecordLocationDeps<Document>['client'] & Pick<MEditClient, 'getReferences'>;
  reporter: Pick<Reporter, 'report'>;
}

export function referencesOf<Document extends { getText(): string }>(
  { client, reporter, open }: ReferencesDeps<Document>,
): (text: string, offset: number) => Promise<RecordLocation<Document>[]> {
  return async (text, offset) => {
    const found = formKeyAt(text, offset);
    if (!found) return [];
    const { formKey } = found;
    const rows = await client.getReferences(formKey).catch((error: unknown) => {
      reporter.report('error', `Find All References cannot list what references ${formKey}.`, errorMessage(error));
      return [];
    });
    const copies = new Map(rows.map((row): [string, RecordCopy] =>
      [JSON.stringify([row.formKey, row.origin, row.plugin]), { formKey: row.formKey, plugin: pluginAddressOf(row) }]));
    const { found: located, leftOut } = await locateCopies(client, [...copies.values()], async (copy, uri) => {
      const document = await open(uri);
      return { uri, document, ...referenceSpan(document.getText(), copy.formKey, formKey) };
    });
    if (leftOut.length > 0) {
      reporter.report('warning', `Find All References on ${formKey} left out the copies it could not open.`, leftOut.join(' '));
    }
    return located;
  };
}
