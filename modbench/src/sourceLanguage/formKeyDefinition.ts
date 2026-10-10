import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { locateRecord, type RecordLocation, type RecordLocationDeps } from './recordLocation';
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
      const located = await locateRecord({ client, open }, { formKey }, formKeyMember);
      if (located && 'refused' in located) {
        reporter.shownOnSurface('warning', `Go to Definition cannot open ${formKey}.`, located.refused);
        return undefined;
      }
      return located;
    } catch (error) {
      reporter.shownOnSurface('error', `Go to Definition cannot open ${formKey}.`, errorMessage(error));
      return undefined;
    }
  };
}
