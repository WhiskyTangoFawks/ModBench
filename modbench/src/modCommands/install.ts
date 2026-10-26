import { basename } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import { refuse } from '../coreLib/refuse';
import type {
  FomodAnswer, FomodLanded, InstallOutcome, InstallPackage, InstallTarget, InstanceAdapter, InstallKeys, DownloadedFile,
} from '../instanceAdapter/instanceAdapter';
import { goneFromDisk } from '../coreLib/commandRefusals';
import { EMPTY_MOD_NAME, modNameTakenRefusal } from './nameRefusals';
import type { CommandResult } from '../coreLib/commandResult';
import type { ModStatus, ReadModStatus } from '../client';
import { failureReason, isReadFailed } from '../wire/readFailed';

/** What a mod is installed from: an installation file or a folder the user picked, or a downloaded file by its name. An
 *  installation file that is one of the downloaded files installs as that file. */
export type ModPackage = InstallPackage | { readonly kind: 'downloadedFile'; readonly name: string };

interface Resolved {
  readonly extracted: InstallPackage;
  readonly file: DownloadedFile | undefined;
}

// The downloaded file a package is, with the Nexus ids and version its metadata holds; none for a folder or an
// installation file outside the downloaded files.
async function resolve(adapter: InstanceAdapter, installed: ModPackage): Promise<Resolved> {
  if (installed.kind === 'folder') return { extracted: installed, file: undefined };
  if (installed.kind === 'archive') {
    const at = await adapter.downloadedFileAt(installed.path);
    if (at.kind === 'unreadable') throw new Error(at.reason);
    return { extracted: installed, file: at.answer };
  }
  const listed = await adapter.downloadedFiles();
  const files = listed.kind === 'listed' ? listed.files ?? [] : [];
  const file = files.find(({ name }) => name === installed.name);
  if (file === undefined) throw new Error(`"${installed.name}" is gone from Downloads.`);
  return { extracted: { kind: 'archive', path: file.path }, file };
}

function keysFor(installed: ModPackage, file: DownloadedFile | undefined): InstallKeys {
  if (file !== undefined) {
    const { modID, installedKey, version, fileCategory } = file.meta ?? {};
    return {
      installationFileName: file.name, nexusId: modID, version, nexusFileStatus: fileCategory,
      installedFileKeys: installedKey === undefined ? undefined : [installedKey],
    };
  }
  return installed.kind === 'archive' ? { installationFileName: basename(installed.path) } : {};
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
    listed('files its package does not hold', status.notInPackage),
    listed('files its package holds with other bytes', status.otherBytes),
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
    const { modFolders } = await adapter.modOrder();
    const wanted = adapter.entryKey({ kind: 'mod', name: mod });
    return modFolders?.some((folder) => adapter.entryKey(folder) === wanted) ? `"${mod}" has no status in the answer.` : undefined;
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

/** `modbench.mod.install`, then a new mod's line, then its downloaded file marked installed. A refusal after the landing
 *  says why that step failed, and the install is not reported as failed (downloads.md, Reporting, story 1). */
export async function installMod(
  deps: { adapter: InstanceAdapter; readStatus: ReadModStatus; listMod: (name: string) => Promise<CommandResult> },
  installed: ModPackage, target: InstallTarget, force: boolean, fomod?: FomodAnswer,
): Promise<CommandResult<{ cancelled?: true; fomod?: FomodLanded; lineRefusal?: string; downloadedFile?: string; downloadedFileRefusal?: string }>> {
  if (target.kind === 'new' && target.name.trim() === '') return { applied: false, refusal: EMPTY_MOD_NAME };
  const loss = force ? undefined : await upgradeLoss(deps, target);
  if (loss !== undefined) return { applied: false, refusal: `${loss} Request it again with force to replace its files.` };
  let outcome: InstallOutcome;
  let file: DownloadedFile | undefined;
  try {
    const resolved = await resolve(deps.adapter, installed);
    ({ file } = resolved);
    outcome = await deps.adapter.install(resolved.extracted, target, keysFor(installed, file), fomod);
  } catch (err) {
    return refuse(err);
  }
  if (!outcome.landed) return outcome.cancelled === true ? { applied: true, cancelled: true } : { applied: false, refusal: claimRefusal(target) };
  const line = target.kind === 'new' ? await deps.listMod(target.name) : { applied: true as const };
  const listed = { applied: true as const, fomod: outcome.fomod, ...(line.applied ? {} : { lineRefusal: line.refusal }) };
  if (file === undefined) return listed;
  const landed = { ...listed, downloadedFile: file.name };
  const downloadedFileRefusal = await markInstalled(deps.adapter, file.name);
  return downloadedFileRefusal === undefined ? landed : { ...landed, downloadedFileRefusal };
}
