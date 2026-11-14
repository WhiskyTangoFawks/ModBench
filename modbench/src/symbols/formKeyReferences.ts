import type { MEditClient } from '../client';
import { copyDocumentUri } from '../textDocuments/recordDocument';
import { answerOf } from '../wire/readFailed';
import { copyUnread, type LocatedCopies, type RecordLocation, type RecordLocationDeps } from './recordLocation';

interface ReferencesDeps<Document> {
  client: Pick<MEditClient, 'getPlacedReferences'>;
  open: RecordLocationDeps<Document>['open'];
}

/** Each place a copy that references `formKey` names it, at the copy's document, and why each copy went unread; a read
 *  mEdit fails throws. */
export function referencesToFormKey<Document extends object>(
  { client, open }: ReferencesDeps<Document>,
): (formKey: string) => Promise<LocatedCopies<RecordLocation<Document>>> {
  return async (formKey) => {
    const placed = answerOf(await client.getPlacedReferences(formKey));
    const opened = await Promise.all(placed.copies.map(async ({ formKey: referrer, plugin, document, spans }):
      Promise<{ found: RecordLocation<Document>[] } | { why: string }> => {
      const copy = { formKey: referrer, plugin };
      const uri = copyDocumentUri(copy, document);
      try {
        const at = await open(uri);
        return { found: spans.map(({ start, end }) => ({ uri, document: at, start, end })) };
      } catch (error) {
        return { why: copyUnread(copy, error) };
      }
    }));
    return {
      found: opened.flatMap((result) => 'found' in result ? result.found : []),
      leftOut: [...placed.leftOut, ...opened.flatMap((result) => 'why' in result ? [result.why] : [])],
    };
  };
}
