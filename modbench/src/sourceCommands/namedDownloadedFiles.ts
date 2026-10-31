import type { FileRead, InstallationFile, InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { ManifestPackage } from '../manifestAdapter/manifestAdapter';
import type { Nexus } from '../nexus/nexus';
import { errorMessage } from '../ports/errorMessage';

// What this machine holds of the installation file a manifest pins.
interface PinHeld {
  /** The downloaded file of the pinned name, else one under another name with the pinned size and hash. */
  readonly read: FileRead<InstallationFile | undefined>;
  /** The file under another name that holds the pinned bytes, when no file has the pinned name. */
  readonly underAnotherName?: InstallationFile;
  /** The file under another name that holds the pinned bytes, when the file of the pinned name holds other bytes or cannot be read. */
  readonly elsewhere?: InstallationFile;
  /** Why a downloaded file could not be checked for the pinned bytes. */
  readonly notes: readonly string[];
}

async function downloadedFileHoldingPin(
  adapter: Pick<InstanceAdapter, 'downloadedFile' | 'downloadedFileHolding'>, pinned: { readonly name: string; readonly size: number; readonly hash: string },
): Promise<PinHeld> {
  const named = await adapter.downloadedFile(pinned.name);
  if (named.kind === 'read' && named.answer?.hash === pinned.hash) return { read: named, notes: [] };
  const { file, notes } = await adapter.downloadedFileHolding(pinned);
  if (named.kind === 'read' && named.answer === undefined) return { read: { kind: 'read', answer: file }, ...(file === undefined ? {} : { underAnotherName: file }), notes };
  return { read: named, ...(file === undefined ? {} : { elsewhere: file }), notes };
}

type Downloading = {
  readonly adapter: Pick<InstanceAdapter, 'downloadedFile' | 'downloadedFileHolding' | 'copyDownloadedFile' | 'putDownloadedFile'>;
  readonly nexus: Pick<Nexus, 'download'>;
};

type ManifestInstallationFile = Extract<ManifestPackage, { kind: 'installationFile' }>;

interface Found {
  readonly read: FileRead<InstallationFile | undefined>;
  readonly why: readonly string[];
}

const notDownloaded = (reason: string): string => `it could not be downloaded from Nexus: ${reason.replace(/\.$/, '')}`;

// modlist-repository.md, Restore from manifest, story 4: Nexus's file, put only when it is the one the manifest names.
async function downloadedOrWhy({ adapter, nexus }: Downloading, { name, hash, host }: ManifestInstallationFile): Promise<string | undefined> {
  if (host === undefined) return 'its manifest names no file on Nexus to download it from';
  const fetched = await nexus.download({ game: host.nexus.game, modID: String(host.nexus.mod), fileID: String(host.nexus.file) });
  if (!fetched.found) return notDownloaded(fetched.reason);
  try {
    const { put } = await adapter.putDownloadedFile(name, fetched.bytes, { hash, info: fetched.info });
    return put ? undefined : notDownloaded('the file Nexus sent is not the one its manifest names');
  } catch (err) {
    return notDownloaded(errorMessage(err));
  } finally {
    // Bytes a put never read hold the server's connection open. A cancel of bytes that ended or failed answers nothing new.
    await fetched.bytes.cancel().catch(() => undefined);
  }
}

const copyFailed = (from: string, err: unknown): string => `it could not be copied from ${from}: ${errorMessage(err).replace(/\.$/, '')}`;

/** The installation files the mods `notFound` lack, by name in the downloads folder: one held under another name is copied to the
 *  pinned name, and one held nowhere is downloaded first. */
export async function namedDownloadedFiles(
  deps: Downloading, notFound: readonly { readonly installationFiles: readonly ManifestInstallationFile[] }[], { onDownload, signal }: { onDownload?: (file: string) => void; signal?: AbortSignal },
): Promise<{
  handed: (name: string | undefined) => InstallationFile | undefined;
  unreadable: (name: string | undefined) => string | undefined;
  /** Why the installation file of `name` is not the pinned one, as sentences: what could not be checked, which file holds the
   *  pinned bytes, and why it was not copied or downloaded. */
  why: (name: string | undefined) => readonly string[];
}> {
  const lacked = new Map(notFound.flatMap(({ installationFiles }) => installationFiles.map((file) => [file.name, file] as const)));
  const found = new Map<string, Found>();
  for (const [name, file] of lacked) {
    const { read, underAnotherName, elsewhere, notes } = await downloadedFileHoldingPin(deps.adapter, file);
    const why = [...notes, ...(elsewhere === undefined ? [] : [`${elsewhere.path} holds the pinned bytes of '${name}'`])];
    if (read.kind === 'unreadable' || (read.answer !== undefined && underAnotherName === undefined) || signal?.aborted) {
      found.set(name, { read, why });
    } else if (underAnotherName !== undefined) {
      try {
        await deps.adapter.copyDownloadedFile(underAnotherName.path, name);
        found.set(name, { read: await deps.adapter.downloadedFile(name), why });
      } catch (err) {
        found.set(name, { read: { kind: 'read', answer: undefined }, why: [...why, copyFailed(underAnotherName.path, err)] });
      }
    } else {
      onDownload?.(name);
      const failed = await downloadedOrWhy(deps, file);
      found.set(name, failed === undefined ? { read: await deps.adapter.downloadedFile(name), why } : { read, why: [...why, failed] });
    }
  }
  const readOf = (name: string | undefined): Found | undefined => (name === undefined ? undefined : found.get(name));
  return {
    handed: (name) => {
      const read = readOf(name)?.read;
      return read?.kind === 'read' ? read.answer : undefined;
    },
    unreadable: (name) => {
      const read = readOf(name)?.read;
      return read?.kind === 'unreadable' ? read.reason : undefined;
    },
    why: (name) => readOf(name)?.why ?? [],
  };
}
