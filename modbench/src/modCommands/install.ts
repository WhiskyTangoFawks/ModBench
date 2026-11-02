import { basename } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import { refuse } from '../coreLib/refuse';
import type {
  FomodAnswer, FomodLanded, InstallOutcome, InstallPackage, InstallTarget, InstalledPackage, InstanceAdapter, DownloadedFile,
} from '../instanceAdapter/instanceAdapter';
import { goneFromDisk } from '../coreLib/commandRefusals';
import { modNameTakenRefusal, newNameRefusal } from './nameRefusals';
import type { CommandResult } from '../coreLib/commandResult';
import { sourceModsOf } from '../manifestAdapter/manifestAdapter';
import type { MoveToTrash } from '../ports/trash';
import { BUILD_FILE } from '../wire/sourceMod';

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

const packagesOf = (installed: ModPackage, file: DownloadedFile | undefined): InstalledPackage[] => {
  if (file !== undefined) return [{ name: file.name, ...file.meta?.version ? { version: file.meta.version } : {} }];
  return installed.kind === 'archive' ? [{ name: basename(installed.path) }] : [];
};

// The folder can appear or vanish between the caller's decision and the install, as the mod
// manager, xEdit or the user own it too, so a claim that disagrees with disk is refused.
const claimRefusal = (target: InstallTarget): string => (target.kind === 'new'
  ? modNameTakenRefusal(target.name)
  : `Cannot upgrade "${target.name}": there is no folder by that name under mods/.`);

const sourceModRefusal = (mod: string): string =>
  `Cannot upgrade "${mod}": it is a source mod, and its next build overwrites what an upgrade writes. Change its ${BUILD_FILE} instead.`;

async function markInstalled(adapter: InstanceAdapter, name: string): Promise<string | undefined> {
  try {
    const marked = await adapter.markDownloadedFile(name, 'Installed');
    return marked.gone ? goneFromDisk(name) : undefined;
  } catch (err) {
    return errorMessage(err);
  }
}

// A new mod whose metadata could not be written is sent to the trash with its folder, so a failed install leaves none behind; an
// upgrade stays, as it does when it fails part way.
async function metadataWritten(adapter: InstanceAdapter, folder: string, packages: readonly InstalledPackage[], target: InstallTarget, trash: MoveToTrash): Promise<void> {
  try {
    await adapter.writeInstalledFrom(folder, packages, trash);
  } catch (err) {
    if (target.kind === 'upgrade') throw err;
    try {
      await trash(folder);
    } catch (trashing) {
      throw new Error(`${errorMessage(err)} Removing the new folder failed too: ${errorMessage(trashing)}`, { cause: err });
    }
    throw err;
  }
}

/** `modbench.mod.install`, then a new mod's line, then its downloaded file marked installed. A refusal after the landing
 *  says why that step failed, and the install is not reported as failed (downloads.md, Reporting, story 1). */
export async function installMod(
  deps: { adapter: InstanceAdapter; listMod: (name: string) => Promise<CommandResult> },
  installed: ModPackage, target: InstallTarget, trash: MoveToTrash, fomod?: FomodAnswer,
): Promise<CommandResult<{ cancelled?: true; fomod?: FomodLanded; lineRefusal?: string; downloadedFile?: string; downloadedFileRefusal?: string }>> {
  const nameRefusal = target.kind === 'new' ? newNameRefusal(target.name) : undefined;
  if (nameRefusal !== undefined) return { applied: false, refusal: nameRefusal };
  if (target.kind === 'upgrade') {
    try {
      const { adapter } = deps;
      const sourceMods = await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceRepositories(), (name) => adapter.entryKey({ kind: 'mod', name }));
      if (sourceMods.builds(target.name)) return { applied: false, refusal: sourceModRefusal(target.name) };
    } catch (err) {
      return refuse(err);
    }
  }
  let outcome: InstallOutcome;
  let file: DownloadedFile | undefined;
  try {
    const resolved = await resolve(deps.adapter, installed);
    ({ file } = resolved);
    outcome = await deps.adapter.install(resolved.extracted, target, trash, fomod);
    if (outcome.landed) {
      const packages = packagesOf(installed, file);
      const folder = packages.length === 0 ? undefined : await deps.adapter.modFolderPath(target.name);
      if (folder !== undefined) await metadataWritten(deps.adapter, folder, packages, target, trash);
    }
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
