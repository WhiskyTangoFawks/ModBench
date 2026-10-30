import type { InstanceAdapter, ModFolder, OtherManifest, SourceMods } from '../instanceAdapter/instanceAdapter';

// ADR-0022: another manifest builds the folder it sits in, which is no mod, so the mod
// manager holds nothing of it: no metadata, no installation file and no game files it takes.
export interface Folders {
  /** The folder `name` builds; undefined when its name gives it none. */
  readonly of: (name: string) => Promise<string | undefined>;
  readonly isMod: (name: string) => boolean;
}

export function foldersOf(adapter: Pick<InstanceAdapter, 'modFolderPath'>, others: readonly OtherManifest[], among?: readonly ModFolder[]): Folders {
  const other = new Map(others.map(({ name, folder }) => [name, folder]));
  return { of: (name) => (other.has(name) ? Promise.resolve(other.get(name)) : adapter.modFolderPath(name, among)), isMod: (name) => !other.has(name) };
}

// A source mod's manifest is in its repository (ADR-0022).
export const sourceFolderOf = (sourceMods: SourceMods, mod: string): { sourceFolder?: string } => {
  const sourceFolder = sourceMods.folderOf(mod);
  return sourceFolder === undefined ? {} : { sourceFolder };
};

export const namesOf = (mods: readonly string[], others: readonly OtherManifest[]): string[] => [...mods, ...others.map(({ name }) => name)];
