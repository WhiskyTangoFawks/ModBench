import { parseTree, type Node } from 'jsonc-parser';
import { errorMessage } from '../ports/errorMessage';
import { pluginAddressOf } from '../wire/pluginAddress';
import { copyDocument, type RecordCopy } from '../drivingLib/recordDocument';
import { formKeyAt } from './formKeyHover';
import { ownFormKey, recordObject, type RecordLocation, type RecordLocationDeps, type TextSpan } from './recordLocation';

// A nested object with a FormKey of its own is a child record, whose references are its own
// (editor-referenced-by.md, The tree, story 5).
const valuesOf = (node: Node): Node[] => (node.type === 'property' ? node.children?.slice(1) : node.children) ?? [];

function firstReference(node: Node, formKey: string): Node | undefined {
  const own = ownFormKey(node)?.parent;
  for (const child of valuesOf(node)) {
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

export function referencesOf<Document extends { getText(): string }>(
  { client, reporter, open }: RecordLocationDeps<Document>,
): (text: string, offset: number) => Promise<RecordLocation<Document>[]> {
  const located = async (copy: RecordCopy, formKey: string): Promise<RecordLocation<Document> | string> => {
    try {
      const opened = await copyDocument(client, copy);
      if ('refused' in opened) return opened.refused;
      const document = await open(opened.uri);
      return { uri: opened.uri, document, ...referenceSpan(document.getText(), copy.formKey, formKey) };
    } catch (error) {
      return `${copy.formKey} in ${copy.plugin.name} (${copy.plugin.origin}): ${errorMessage(error)}`;
    }
  };
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
    const results = await Promise.all([...copies.values()].map((copy) => located(copy, formKey)));
    const leftOut = results.filter((result) => typeof result === 'string');
    if (leftOut.length > 0) {
      reporter.report('warning', `Find All References on ${formKey} left out the copies it could not open.`, leftOut.join(' '));
    }
    return results.filter((result) => typeof result !== 'string');
  };
}
