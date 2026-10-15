import type { components } from './generated/api';

/** A mod by its folder, with its metadata files. */
export type ModByFolder = components['schemas']['ModByFolder'];

type HeldMetadata =
  | { readonly kind: 'read'; readonly answer: { readonly version?: string; readonly installationFiles: readonly { readonly name: string; readonly source?: string }[] } }
  | { readonly kind: 'unreadable'; readonly reason: string };

export function modWithMetadata(mod: ModByFolder, held: HeldMetadata): ModByFolder {
  return held.kind === 'unreadable'
    ? { ...mod, metadataUnreadable: held.reason }
    : { ...mod, metadata: { version: held.answer.version, installationFiles: [...held.answer.installationFiles] } };
}

export const withMetadataRead = (mods: readonly ModByFolder[], readOf: (mod: string) => Promise<HeldMetadata>): Promise<ModByFolder[]> =>
  Promise.all(mods.map(async (mod) => modWithMetadata(mod, await readOf(mod.name))));
