import type { ManifestInstallationFile, NotFound, RestoreMod } from '../client';
import type { FileRead, InstallationFile, InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { Nexus } from '../nexus/nexus';
import { errorMessage } from '../ports/errorMessage';

interface Deps {
  readonly adapter: Pick<InstanceAdapter, 'downloadedFile' | 'nexusFileAt' | 'putDownloadedFile'>;
  readonly nexus: Pick<Nexus, 'download'>;
}

interface Found {
  readonly read: FileRead<InstallationFile | undefined>;
  readonly notDownloaded?: string;
}

const notDownloaded = (reason: string): string => `it could not be downloaded from Nexus: ${reason.replace(/\.$/, '')}`;

// modlist-repository.md, Restore from manifest, story 10: Nexus's file, put only when it is the one the manifest names.
async function downloadedOrWhy({ adapter, nexus }: Deps, { name, hash, page }: ManifestInstallationFile): Promise<string | undefined> {
  const at = page === undefined ? undefined : adapter.nexusFileAt(page);
  if (at?.fileId === undefined) return 'its manifest names no file on Nexus to download it from';
  const fetched = await nexus.download({ game: at.game, modID: at.modId, fileID: at.fileId });
  if (!fetched.found) return notDownloaded(fetched.reason);
  try {
    const { put } = await adapter.putDownloadedFile(name, fetched.bytes, { hash, info: fetched.info });
    return put ? undefined : notDownloaded('the file Nexus sent is not the one its manifest names');
  } catch (err) {
    return notDownloaded(errorMessage(err));
  }
}

/** The installation files the mods `notFound` lacks, by name in the downloads folder, each one it lacks downloaded first. */
export async function namedDownloadedFiles(
  deps: Deps, notFound: readonly NotFound[], { onDownload, signal }: { onDownload?: (file: string) => void; signal?: AbortSignal },
): Promise<{
  handed: (name: string | undefined) => RestoreMod['installationFile'];
  unreadable: (name: string | undefined) => string | undefined;
  /** Why the installation file of `name`, which the downloads folder lacks, was not downloaded. */
  notDownloaded: (name: string | undefined) => string | undefined;
}> {
  const lacked = new Map(notFound.flatMap(({ installationFile }) => (installationFile === undefined ? [] : [[installationFile.name, installationFile] as const])));
  const found = new Map<string, Found>();
  for (const [name, file] of lacked) {
    const read = await deps.adapter.downloadedFile(name);
    if (read.kind === 'unreadable' || read.answer !== undefined || signal?.aborted) {
      found.set(name, { read });
      continue;
    }
    onDownload?.(name);
    const why = await downloadedOrWhy(deps, file);
    found.set(name, why === undefined ? { read: await deps.adapter.downloadedFile(name) } : { read, notDownloaded: why });
  }
  const readOf = (name: string | undefined): Found | undefined => (name === undefined ? undefined : found.get(name));
  return {
    handed: (name) => {
      const read = readOf(name)?.read;
      return read?.kind === 'read' && read.answer !== undefined ? wireFile(read.answer) : undefined;
    },
    unreadable: (name) => {
      const read = readOf(name)?.read;
      return read?.kind === 'unreadable' ? read.reason : undefined;
    },
    notDownloaded: (name) => readOf(name)?.notDownloaded,
  };
}

export const wireFile = ({ path, page, size, hash, entries }: InstallationFile): NonNullable<RestoreMod['installationFile']> =>
  ({ path, page, size, hash, entries: [...entries] });
