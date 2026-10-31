import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';

type FolderValue = Awaited<ReturnType<InstanceAdapter['folderValue']>>;

const isGitsOwn = (path: string): boolean => path === '.git' || path.startsWith('.git/');

/** A source folder's files as its manifest records them: git's own are the repository's, not the folder's. */
export async function sourceFolderValue(adapter: Pick<InstanceAdapter, 'folderValue'>, folder: string): Promise<FolderValue> {
  const value = await adapter.folderValue(folder);
  return { ...value, files: new Map([...value.files].filter(([path]) => !isGitsOwn(path))) };
}
