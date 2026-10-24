import type { CopyDocument, MEditClient } from '../../client/MEditClient';

export interface CopyOnDisk { file?: string; rendered?: string; text?: string }

export const copyKey = (formKey: string, { name, origin }: { name: string; origin: string }): string => `${formKey} ${name} ${origin}`;

export function copyDocumentsOf(copiesByKey: Record<string, CopyOnDisk>) {
  const firstOnFile = (path: string) => Object.entries(copiesByKey).find(([, copy]) => copy.file === path);
  const ownFileOrContainers = (key: string, file: string): CopyDocument['kind'] => (firstOnFile(file)?.[0] === key ? 'OwnFile' : 'ContainersFile');
  const getCopyDocument: MEditClient['getCopyDocument'] = (plugin, formKey) => {
    const key = copyKey(formKey, plugin);
    const copy = copiesByKey[key];
    if (copy?.file) return Promise.resolve({ kind: ownFileOrContainers(key, copy.file), location: copy.file });
    return Promise.resolve(copy?.rendered ? { kind: 'Rendered', location: copy.rendered } : null);
  };
  return { getCopyDocument, textOnFile: (path: string) => firstOnFile(path)?.[1].text };
}
