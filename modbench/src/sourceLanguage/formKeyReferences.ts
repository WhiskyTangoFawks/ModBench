import type { MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { pluginAddressOf } from '../wire/pluginAddress';
import type { RecordCopy } from '../drivingLib/recordDocument';
import { locateCopies, type RecordLocation, type RecordLocationDeps } from './recordLocation';
import { formKeyAt, referenceSpan } from './sourceText';

interface ReferencesDeps<Document> extends RecordLocationDeps<Document> {
  client: RecordLocationDeps<Document>['client'] & Pick<MEditClient, 'getReferencesInActiveOrTrackedPlugins'>;
  reporter: Pick<Reporter, 'shownOnSurface'>;
}

export function referencesOf<Document extends { getText(): string }>(
  { client, reporter, open }: ReferencesDeps<Document>,
): (text: string, offset: number) => Promise<RecordLocation<Document>[]> {
  return async (text, offset) => {
    const found = formKeyAt(text, offset);
    if (!found) return [];
    const { formKey } = found;
    const rows = await client.getReferencesInActiveOrTrackedPlugins(formKey).catch((error: unknown) => {
      reporter.shownOnSurface('error', `Find All References cannot list what references ${formKey}.`, errorMessage(error));
      return [];
    });
    const copies = new Map(rows.map((row): [string, RecordCopy] =>
      [JSON.stringify([row.formKey, row.origin, row.plugin]), { formKey: row.formKey, plugin: pluginAddressOf(row) }]));
    const { found: located, leftOut } = await locateCopies(client, [...copies.values()], async (copy, uri) => {
      const document = await open(uri);
      return { uri, document, ...referenceSpan(document.getText(), copy.formKey, formKey) };
    });
    for (const why of leftOut) {
      reporter.shownOnSurface('warning', `Find All References on ${formKey} left out a copy it could not open.`, why);
    }
    return located;
  };
}
