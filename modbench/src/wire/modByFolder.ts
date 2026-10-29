import type { components } from './generated/api';

/** A mod by its folder, with its metadata files. */
export type ModByFolder = components['schemas']['ModByFolder'];

type HeldMetadata =
  | { readonly kind: 'read'; readonly answer: { readonly version?: string; readonly installationFile?: { readonly name: string; readonly page?: string } } }
  | { readonly kind: 'unreadable'; readonly reason: string };

export function modWithMetadata(mod: ModByFolder, held: HeldMetadata): ModByFolder {
  return held.kind === 'unreadable'
    ? { ...mod, metadataUnreadable: held.reason }
    : { ...mod, metadata: { version: held.answer.version, installationFile: held.answer.installationFile } };
}
