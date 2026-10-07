import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { recordDocument } from '../drivingLib/recordDocument';
import { formKeyAt } from './formKeyHover';
import type { RecordLocation, RecordLocationDeps } from './recordLocation';
import { formKeyMember } from './recordText';

interface DefinitionDeps<Document> extends RecordLocationDeps<Document> {
  reporter: Pick<Reporter, 'shownOnSurface'>;
}

/** A refusal or a failure offers no definition, and is written to the Output once for each reason
 *  (common.md, Reporting). */
export function definitionsOf<Document extends { getText(): string }>(
  { client, reporter, open }: DefinitionDeps<Document>,
): (text: string, offset: number) => Promise<RecordLocation<Document> | undefined> {
  const told = new Set<string>();
  const tell = (formKey: string, why: string) => {
    if (told.has(why)) return;
    told.add(why);
    reporter.shownOnSurface('warning', `Go to Definition cannot open ${formKey}.`, why);
  };
  return async (text, offset) => {
    const found = formKeyAt(text, offset);
    if (!found) return undefined;
    const { formKey } = found;
    try {
      const opened = await recordDocument(client, { formKey });
      if (!opened) return undefined;
      if ('refused' in opened) {
        tell(formKey, opened.refused);
        return undefined;
      }
      const document = await open(opened.uri);
      const member = formKeyMember(document.getText(), formKey);
      return member && { uri: opened.uri, document, ...member };
    } catch (error) {
      tell(formKey, errorMessage(error));
      return undefined;
    }
  };
}
