import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';

type FolderReader = Pick<InstanceAdapter, 'modFolderPath' | 'metadataFilesInModFolder'>;

/** Each mod that has a folder, by that folder and the metadata files the mod manager keeps in it. */
export async function byFolder(
  adapter: FolderReader, mods: readonly string[],
): Promise<{ name: string; folder: string; metadataFiles: string[] }[]> {
  const asked = [];
  for (const mod of mods) {
    const folder = await adapter.modFolderPath(mod);
    if (folder !== undefined) asked.push({ name: mod, folder, metadataFiles: [...adapter.metadataFilesInModFolder] });
  }
  return asked;
}
