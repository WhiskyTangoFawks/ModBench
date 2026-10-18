import { basename } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import { refuse } from '../ports/refuse';
import { samePath } from '../instanceAdapter/instanceAdapter';
import type {
  InstallOutcome, InstallPackage, InstallTarget, InstanceAdapter, InstallKeys, DownloadedFile,
} from '../instanceAdapter/instanceAdapter';
import { EMPTY_MOD_NAME, goneFromDisk, modNameTakenRefusal } from '../coreLib/commandRefusals';
import type { CommandResult } from '../coreLib/commandResult';
import type { ModStatus, ReadModStatus } from '../client';
import { failureReason, isReadFailed } from '../wire/readFailed';

/** What a mod is installed from: an archive or a folder the user picked, or a downloaded file by its name. An
 *  archive that is one of the downloaded files installs as that file. */
export type ModPackage = InstallPackage | { readonly kind: 'downloadedFile'; readonly name: string };

interface Resolved {
  readonly extracted: InstallPackage;
  readonly file: DownloadedFile | undefined;
}

// The downloaded file a package is, with the Nexus ids and version its metadata holds; none for a folder or an
// archive outside the downloaded files.
async function resolve(adapter: InstanceAdapter, installed: ModPackage): Promise<Resolved> {
  if (installed.kind === 'folder') return { extracted: installed, file: undefined };
  const listed = await adapter.downloadedFiles();
  const files = listed.kind === 'listed' ? listed.files ?? [] : [];
  if (installed.kind === 'archive') return { extracted: installed, file: files.find(({ path }) => samePath(path, installed.path)) };
  const file = files.find(({ name }) => name === installed.name);
  if (file === undefined) throw new Error(`"${installed.name}" is gone from Downloads.`);
  return { extracted: { kind: 'archive', path: file.path }, file };
}

function keysFor(installed: ModPackage, file: DownloadedFile | undefined): InstallKeys {
  if (file !== undefined) {
    const { modID, fileID, version } = file.meta ?? {};
    const installedFiles = modID && fileID ? [{ nexusId: modID, fileId: fileID }] : undefined;
    return { archiveFilename: file.name, nexusId: modID, version, installedFiles };
  }
  return installed.kind === 'archive' ? { archiveFilename: basename(installed.path) } : {};
}

// The folder can appear or vanish between the caller's decision and the install, as the mod
// manager, xEdit or the user own it too, so a claim that disagrees with disk is refused.
const claimRefusal = (target: InstallTarget): string => (target.kind === 'new'
  ? modNameTakenRefusal(target.name)
  : `Cannot upgrade "${target.name}": there is no folder by that name under mods/.`);

const listed = (what: string, files: readonly string[]): string | undefined =>
  (files.length > 0 ? `${what}: ${files.join(', ')}` : undefined);

const lossOf = (status: ModStatus): string | undefined => {
  const parts = [
    status.noManifest ? 'it has no manifest' : undefined,
    listed('files whose bytes differ from its manifest', status.differing),
    listed('files no line of its manifest names', status.namedByNoLine),
    listed('files its manifest names that its folder lacks', status.gone),
    listed('files its package does not hold', status.notInPackage),
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join('; ');
};

const statusUnread = (mod: string, why: string): string => `"${mod}" status could not be read: ${why.replace(/\.$/, '')}.`;

/** What an upgrade over the mod would lose, or why mEdit could not say (agent.md, Any agent, story 7). Nothing for a
 *  new mod and for an upgrade that loses nothing. */
export async function upgradeLoss(
  { adapter, readStatus }: { adapter: InstanceAdapter; readStatus: ReadModStatus }, target: InstallTarget,
): Promise<string | undefined> {
  if (target.kind !== 'upgrade') return undefined;
  const mod = target.name;
  const answer = await readStatus([mod]);
  if (isReadFailed(answer)) return statusUnread(mod, failureReason(answer));
  const status = answer.find((read) => read.mod === mod);
  if (status === undefined) {
    return await adapter.modFolderPath(mod) === undefined ? undefined : `"${mod}" has no status in the answer.`;
  }
  if (status.unreadable) return statusUnread(mod, status.unreadable.why);
  const loss = lossOf(status);
  return loss === undefined ? undefined : `The upgrade would lose, in "${mod}": ${loss}.`;
}

async function markInstalled(adapter: InstanceAdapter, name: string): Promise<string | undefined> {
  try {
    const marked = await adapter.markDownloadedFile(name, 'Installed');
    return marked.gone ? goneFromDisk(name) : undefined;
  } catch (err) {
    return errorMessage(err);
  }
}

/** `modbench.mod.install`, then the downloaded file it installed from marked installed. `downloadedFileRefusal` says why the
 *  mark failed, so a landed install is not reported as failed (downloads.md, Reporting, story 1). */
export async function installMod(
  deps: { adapter: InstanceAdapter; readStatus: ReadModStatus },
  installed: ModPackage, target: InstallTarget, force: boolean,
): Promise<CommandResult<{ isFomod: boolean; downloadedFile?: string; downloadedFileRefusal?: string }>> {
  if (target.kind === 'new' && target.name.trim() === '') return { applied: false, refusal: EMPTY_MOD_NAME };
  const loss = force ? undefined : await upgradeLoss(deps, target);
  if (loss !== undefined) return { applied: false, refusal: `${loss} Request it again with force to replace its files.` };
  let outcome: InstallOutcome;
  let file: DownloadedFile | undefined;
  try {
    const resolved = await resolve(deps.adapter, installed);
    ({ file } = resolved);
    outcome = await deps.adapter.install(resolved.extracted, target, keysFor(installed, file));
  } catch (err) {
    return refuse(err);
  }
  if (!outcome.landed) return { applied: false, refusal: claimRefusal(target) };
  if (file === undefined) return { applied: true, isFomod: outcome.isFomod };
  const landed = { applied: true as const, isFomod: outcome.isFomod, downloadedFile: file.name };
  const downloadedFileRefusal = await markInstalled(deps.adapter, file.name);
  return downloadedFileRefusal === undefined ? landed : { ...landed, downloadedFileRefusal };
}
