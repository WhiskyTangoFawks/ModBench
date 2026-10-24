import type { MEditClient } from '../../client';

/** A plugin's copy of a record: the file its plugin source holds it in, or the name it is rendered under. */
export interface Copy { file?: string; rendered?: string; text?: string }

export const copyKey = (formKey: string, { name, origin }: { name: string; origin: string }): string => `${formKey} ${name} ${origin}`;

/** mEdit's copy documents over `copies`, keyed by {@link copyKey}: the first copy on a file has it as its own, a later one as its container's. */
export function copyDocuments(copies: Record<string, Copy>) {
  const firstOnFile = (path: string) => Object.entries(copies).find(([, copy]) => copy.file === path);
  const getCopyDocument: MEditClient['getCopyDocument'] = (plugin, formKey) => {
    const key = copyKey(formKey, plugin);
    const copy = copies[key];
    if (copy?.file) return Promise.resolve({ kind: firstOnFile(copy.file)?.[0] !== key ? 'ContainersFile' : 'OwnFile', location: copy.file });
    return Promise.resolve(copy?.rendered ? { kind: 'Rendered', location: copy.rendered } : null);
  };
  return { getCopyDocument, textOnFile: (path: string) => firstOnFile(path)?.[1].text };
}
