import { basename } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import { refuse } from '../ports/refuse';
import type {
  InstallOutcome, InstallSource, InstallTarget, InstanceAdapter, OwnedMetaKeys,
} from '../instanceAdapter/instanceAdapter';
import { EMPTY_MOD_NAME, goneFromDisk, modNameTakenRefusal } from '../coreLib/commandRefusals';
import type { CommandResult } from '../coreLib/commandResult';
import type { ModStatus, ReadModStatus } from '../client';
import { failureReason, isReadFailed } from '../wire/readFailed';

/** What a mod is installed from: an archive or a folder the user picked, or a downloaded file by
 *  its name and path in the instance value, with the Nexus ids and version its metadata holds. */
export type ModSource = InstallSource | {
  readonly kind: 'downloadedFile';
  readonly name: string;
  readonly path: string;
  readonly modID?: string;
  readonly fileID?: string;
  readonly version?: string;
};

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

const listed = (what: string, files: readonly string[]): string | undefined =>
  (files.length > 0 ? `${what}: ${files.join(', ')}` : undefined);

const upgradeLoss = (status: ModStatus): string | undefined => {
  const parts = [
    status.noManifest ? 'it has no manifest' : undefined,
    listed('files whose bytes differ from its manifest', status.differing),
    listed('files no line of its manifest names', status.namedByNoLine),
    listed('files its manifest names that its folder lacks', status.gone),
    listed('files with no provider', status.noProvider),
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join('; ');
};

const FORCE_TO_REPLACE = 'Request it again with force to replace its files.';

const statusUnread = (mod: string, why: string): string =>
  `"${mod}" status could not be read: ${why.replace(/\.$/, '')}. ${FORCE_TO_REPLACE}`;

// What an upgrade over the mod would lose, or why mEdit could not say (agent.md, Any agent, story 7).
async function upgradeRefusal(
  { adapter, readStatus }: { adapter: InstanceAdapter; readStatus: ReadModStatus }, target: InstallTarget, force: boolean,
): Promise<string | undefined> {
  if (force || target.kind !== 'upgrade') return undefined;
  const mod = target.name;
  const answer = await readStatus([mod]);
  if (isReadFailed(answer)) return statusUnread(mod, failureReason(answer));
  const status = answer.find((read) => read.mod === mod);
  if (status === undefined) {
    return await adapter.modFolderPath(mod) === undefined ? undefined
      : `"${mod}" has no status in the answer. ${FORCE_TO_REPLACE}`;
  }
  if (status.unreadable) return statusUnread(mod, status.unreadable.why);
  const loss = upgradeLoss(status);
  return loss === undefined ? undefined : `The upgrade would lose, in "${mod}": ${loss}. ${FORCE_TO_REPLACE}`;
}

async function markInstalled(adapter: InstanceAdapter, name: string): Promise<string | undefined> {
  try {
    const marked = await adapter.markDownloadedFile(name, 'Installed');
    return marked.gone ? goneFromDisk(name) : undefined;
  } catch (err) {
    return errorMessage(err);
  }
}

/** `modbench.mod.install`, then a downloaded file marked installed. `downloadRefusal` says why the
 *  mark failed, so a landed install is not reported as failed (downloads.md, Reporting, story 1). */
export async function installMod(
  deps: { adapter: InstanceAdapter; readStatus: ReadModStatus },
  source: ModSource, target: InstallTarget, gameName: string, force: boolean,
): Promise<CommandResult<{ isFomod: boolean; downloadRefusal?: string }>> {
  if (target.kind === 'new' && target.name.trim() === '') return { applied: false, refusal: EMPTY_MOD_NAME };
  const refusal = await upgradeRefusal(deps, target, force);
  if (refusal !== undefined) return { applied: false, refusal };
  let outcome: InstallOutcome;
  try {
    const extracted = source.kind === 'downloadedFile' ? { kind: 'archive' as const, path: source.path } : source;
    outcome = await deps.adapter.install(extracted, target, keysFor(source, gameName));
  } catch (err) {
    return refuse(err);
  }
  if (!outcome.landed) return { applied: false, refusal: claimRefusal(target) };
  const landed = { applied: true as const, isFomod: outcome.isFomod };
  if (source.kind !== 'downloadedFile') return landed;
  const downloadRefusal = await markInstalled(deps.adapter, source.name);
  return downloadRefusal === undefined ? landed : { ...landed, downloadRefusal };
}
