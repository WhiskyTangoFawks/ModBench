import type { MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { pluginAddressOf } from '../wire/pluginAddress';
import type { RecordCopy } from '../wire/recordCopy';
import { locateCopies, type RecordLocation, type RecordLocationDeps } from './recordLocation';
import { heldText } from '../textDocuments/heldText';
import { formKeyAt, referenceSpan } from './sourceText';
import { answerOf } from '../wire/readFailed';

interface ReferencesDeps<Document> extends RecordLocationDeps<Document> {
  client: RecordLocationDeps<Document>['client'] & Pick<MEditClient, 'getReferencesInActiveOrCompiledPlugins'>;
  reporter: Pick<Reporter, 'shownOnSurface'>;
}

/** Each copy that references `formKey`, at its document, and why each went unread; a read mEdit fails throws. */
export function referencesToFormKey<Document extends { getText(): string }>(
  { client, open }: Omit<ReferencesDeps<Document>, 'reporter'>,
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

export function referencesOf<Document extends { getText(): string }>(
  { reporter, ...deps }: ReferencesDeps<Document>,
): (text: string, offset: number) => Promise<RecordLocation<Document>[]> {
  const read = referencesToFormKey(deps);
  return async (text, offset) => {
    const found = formKeyAt(text, offset);
    if (!found) return [];
    const { formKey } = found;
    const { found: located, leftOut } = await read(formKey).catch((error: unknown) => {
      reporter.shownOnSurface('error', `Find All References cannot list what references ${formKey}.`, errorMessage(error));
      return { found: [], leftOut: [] };
    });
    for (const why of leftOut) {
      reporter.shownOnSurface('warning', `Find All References on ${formKey} left out a copy it could not open.`, why);
    }
    return located;
  };
}
