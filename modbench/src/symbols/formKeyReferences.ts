import { referenceSpan, type MEditClient } from '../client';
import { pluginAddressOf } from '../wire/pluginAddress';
import type { RecordCopy } from '../wire/recordCopy';
import { locateCopies, type RecordLocation, type RecordLocationDeps } from './recordLocation';
import { heldText } from '../textDocuments/heldText';
import { answerOf } from '../wire/readFailed';

interface ReferencesDeps<Document> extends RecordLocationDeps<Document> {
  client: RecordLocationDeps<Document>['client'] & Pick<MEditClient, 'getReferencesInActiveOrCompiledPlugins'>;
}

/** Each copy that references `formKey`, at its document, and why each went unread; a read mEdit fails throws. */
export function referencesToFormKey<Document extends { getText(): string }>(
  { client, open }: ReferencesDeps<Document>,
): (formKey: string) => Promise<{ found: RecordLocation<Document>[]; leftOut: string[] }> {
  return async (formKey) => {
    const rows = await client.getReferencesInActiveOrCompiledPlugins(formKey).then(answerOf);
    const copies = new Map(rows.map((row): [string, RecordCopy] =>
      [JSON.stringify([row.formKey, row.origin, row.plugin]), { formKey: row.formKey, plugin: pluginAddressOf(row) }]));
    return locateCopies(client, [...copies.values()], async (copy, uri) => {
      const document = await open(uri);
      return { uri, document, ...referenceSpan(heldText(document), copy.formKey, formKey) };
    });
  };
}
