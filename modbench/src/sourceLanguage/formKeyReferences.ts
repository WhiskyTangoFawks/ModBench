import type * as vscode from 'vscode';
import { parseTree, type Node } from 'jsonc-parser';
import type { MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import { recordDocument, type RecordCopy, type RecordDocumentClient } from '../drivingLib/recordDocument';
import { formKeyAt } from './formKeyHover';
import { ownFormKey, recordObject, type TextSpan } from './formKeyDefinition';

export type ReferencesClient = RecordDocumentClient & Pick<MEditClient, 'getReferences'>;

export interface ReferencesDeps<Document> {
  client: ReferencesClient;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  open: (uri: vscode.Uri) => PromiseLike<Document>;
}

export interface Reference<Document> extends TextSpan { uri: vscode.Uri; document: Document }

// A nested object with a FormKey of its own is a child record, whose references are its own
// (editor-referenced-by.md, The tree, story 5).
function firstReference(node: Node, formKey: string): Node | undefined {
  for (const child of node.children ?? []) {
    if (child === ownFormKey(node)?.parent || ownFormKey(child) !== undefined) continue;
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

/** A refusal or a failure leaves its copy out, and is written to the Output once for each reason
 *  (common.md, Reporting). */
export function referencesOf<Document extends { getText(): string }>(
  { client, reporter, open }: ReferencesDeps<Document>,
): (text: string, offset: number) => Promise<Reference<Document>[]> {
  const told = new Set<string>();
  const tell = (formKey: string, why: string) => {
    if (told.has(why)) return;
    told.add(why);
    reporter.shownOnSurface('warning', `Find All References cannot list every reference to ${formKey}.`, why);
  };
  const located = async (copy: RecordCopy, formKey: string): Promise<Reference<Document>[]> => {
    const opened = await recordDocument(client, copy);
    if (!opened) return [];
    if ('refused' in opened) {
      tell(formKey, opened.refused);
      return [];
    }
    const document = await open(opened.uri);
    return [{ uri: opened.uri, document, ...referenceSpan(document.getText(), copy.formKey, formKey) }];
  };
  const failed = (formKey: string) => (error: unknown): [] => {
    tell(formKey, errorMessage(error));
    return [];
  };
  return async (text, offset) => {
    const found = formKeyAt(text, offset);
    if (!found) return [];
    const { formKey } = found;
    const rows = await client.getReferences(formKey).catch(failed(formKey));
    const copies = new Map(rows.map((row): [string, RecordCopy] =>
      [JSON.stringify([row.formKey, row.origin, row.plugin]), { formKey: row.formKey, plugin: { name: row.plugin, origin: row.origin } }]));
    const references = await Promise.all([...copies.values()].map((copy) => located(copy, formKey).catch(failed(formKey))));
    return references.flat();
  };
}
