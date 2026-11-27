import type { DocumentName } from '../../client';

/** mEdit's names of plugin source, as its record index answers them: each name `answer` gives a text, and those whose
 *  span holds the offset when asked at one. */
export function mEditNames(answer: (text: string, path?: string) => readonly DocumentName[]) {
  return {
    getPluginSourceNames: (text: string, path?: string, at?: number) =>
      Promise.resolve(answer(text, path).filter(({ start, end }) => at === undefined || (start <= at && at <= end))),
  };
}

/** The name of `kind` that `text` spells as `spelled`, at its first spelling. */
export function spelledName(kind: DocumentName['kind'], text: string, spelled: string, over: Partial<DocumentName> = {}): DocumentName {
  const start = text.indexOf(spelled);
  return { kind, start, end: start + spelled.length, value: spelled, ...over };
}
