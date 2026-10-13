import { basename } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import { refuse } from '../ports/refuse';
import type {
  InstallOutcome, InstallSource, InstallTarget, InstanceAdapter, OwnedMetaKeys,
} from '../instanceAdapter/instanceAdapter';
import { goneFromDisk, modNameTakenRefusal } from '../coreLib/commandRefusals';
import type { CommandResult } from '../coreLib/commandResult';

/** A downloaded file, by its name and path in the instance value, with the Nexus ids and version
 *  its metadata holds. */
export interface DownloadedFileSource {
  readonly kind: 'downloadedFile';
  readonly name: string;
  readonly path: string;
  readonly modID?: string;
  readonly fileID?: string;
  readonly version?: string;
}

/** What a mod is installed from: an archive or a folder the user picked, or a downloaded file. */
export type ModSource = InstallSource | DownloadedFileSource;

/** `downloadRefusal` is set when the mod landed and its downloaded file could not be marked
 *  installed, so the install is not reported as failed (downloads.md, Reporting, story 1). */
export type InstallResult = CommandResult<{ isFomod: boolean; downloadRefusal?: string }>;

function keysFor(source: ModSource, gameName: string): OwnedMetaKeys {
  if (source.kind === 'folder') return { gameName };
  if (source.kind === 'archive') return { gameName, archiveFilename: basename(source.path) };
  const { name, modID, fileID, version } = source;
  const installedFiles = modID && fileID ? [{ nexusId: modID, fileId: fileID }] : undefined;
  return { gameName, archiveFilename: name, nexusId: modID, version, installedFiles };
}

// The folder can appear or vanish between the caller's decision and the install, as the mod
// manager, xEdit or the user own it too, so a claim that disagrees with disk is refused.
const claimRefusal = (target: InstallTarget): string => (target.kind === 'new'
  ? modNameTakenRefusal(target.name)
  : `Cannot upgrade "${target.name}": there is no folder by that name under mods/.`);

async function markInstalled(adapter: InstanceAdapter, name: string): Promise<string | undefined> {
  try {
    const marked = await adapter.markDownloadedFile(name, 'Installed');
    return marked.gone ? goneFromDisk(name) : undefined;
  } catch (err) {
    return errorMessage(err);
  }
}

/** `modbench.mod.install`: the source into a new mod or over an installed one, then a downloaded
 *  file marked installed. */
export async function installMod(
  adapter: InstanceAdapter, source: ModSource, target: InstallTarget, gameName: string,
): Promise<InstallResult> {
  let outcome: InstallOutcome;
  try {
    const extracted = source.kind === 'downloadedFile' ? { kind: 'archive' as const, path: source.path } : source;
    outcome = await adapter.install(extracted, target, keysFor(source, gameName));
  } catch (err) {
    return refuse(err);
  }
  if (!outcome.landed) return { applied: false, refusal: claimRefusal(target) };
  const landed = { applied: true as const, isFomod: outcome.isFomod };
  if (source.kind !== 'downloadedFile') return landed;
  const downloadRefusal = await markInstalled(adapter, source.name);
  return downloadRefusal === undefined ? landed : { ...landed, downloadRefusal };
}
