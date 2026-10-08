import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { recordDocument } from '../drivingLib/recordDocument';
import type { RecordLocation, RecordLocationDeps } from './recordLocation';
import { formKeyAt, formKeyMember } from './sourceText';

interface DefinitionDeps<Document> extends RecordLocationDeps<Document> {
  reporter: Pick<Reporter, 'shownOnSurface'>;
}

/** A refusal or a failure offers no definition, and is written to the Output (ADR-0019). */
export function definitionsOf<Document extends { getText(): string }>(
  { client, reporter, open }: DefinitionDeps<Document>,
): (text: string, offset: number) => Promise<RecordLocation<Document> | undefined> {
  return async (text, offset) => {
    const found = formKeyAt(text, offset);
    if (!found) return undefined;
    const { formKey } = found;
    try {
      const opened = await recordDocument(client, { formKey });
      if (!opened) return undefined;
      if ('refused' in opened) {
        reporter.shownOnSurface('warning', `Go to Definition cannot open ${formKey}.`, opened.refused);
        return undefined;
      }
      const document = await open(opened.uri);
      const member = formKeyMember(document.getText(), formKey);
      if (!member) {
        reporter.shownOnSurface('warning', `Go to Definition cannot open ${formKey}.`, `${opened.uri.path} states no ${formKey} member.`);
        return undefined;
      }
      return { uri: opened.uri, document, ...member };
    } catch (error) {
      reporter.shownOnSurface('error', `Go to Definition cannot open ${formKey}.`, errorMessage(error));
      return undefined;
    }
  };
}
