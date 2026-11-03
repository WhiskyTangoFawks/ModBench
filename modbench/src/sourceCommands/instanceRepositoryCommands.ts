import type { CommandResult } from '../coreLib/commandResult';
import type { InstanceAdapter, OtherManifest } from '../instanceAdapter/instanceAdapter';
import { errorMessage } from '../ports/errorMessage';
import { refuse } from '../coreLib/refuse';
import type { HostGit } from '../ports/repository';
import { ignoreFiles, type FileToIgnore } from './ignoreFiles';
import { initRepositoryIn } from './initRepositoryIn';
import { updateManifest, type UpdateManifestDeps, type UpdateManifestResult, type UpdateManifestStatus } from './updateManifest';
import {
  otherManifestsOf, restoreFromManifest, type OtherManifests, type RestoreDeps, type RestoreResult, type RestoreStatus,
} from './restoreFromManifest';

export type { OtherManifests, RestoreResult, RestoreStatus } from './restoreFromManifest';

type Adapter = UpdateManifestDeps['adapter'] & RestoreDeps['adapter'] & Pick<InstanceAdapter,
  'ownPath' | 'checkPushRefusalFree' | 'publisherConfigurationRefusal' | 'writeIgnoreList' | 'removeRepository'>;

interface InstanceRepositoryCommandsDeps extends Omit<RestoreDeps, 'adapter'> {
  readonly adapter: Adapter;
  readonly instanceRoot: string;
  readonly hostGit: HostGit<unknown>;
}

// A failed init leaves nothing behind: what it wrote goes, and what stays is named.
interface TakenBack { readonly what: string; readonly undo: () => Promise<void> }

async function refusalTakenBack(failure: unknown, undone: readonly TakenBack[]): Promise<string> {
  let refusal = errorMessage(failure);
  for (const { what, undo } of undone) {
    try {
      await undo();
    } catch (err) {
      refusal += `; ${what} remains: ${errorMessage(err)}`;
    }
  }
  return refusal;
}

/** pathTokensNotWritten: why a path token stays in the working tree. pushRefusalNotWritten: why an adopted repository's
 *  own pre-push hook was left in place. */
export type GitInitResult = CommandResult<{ pathTokensNotWritten?: string; pushRefusalNotWritten?: string }>;

async function gitInit({ adapter, instanceRoot, hostGit }: InstanceRepositoryCommandsDeps): Promise<GitInitResult> {
  const adopting = await adapter.repositoryOnDisk();
  let takenBack: TakenBack[] = [];
  try {
    if (!adopting) await adapter.checkPushRefusalFree();
    const unreadable = await adapter.publisherConfigurationRefusal();
    if (unreadable !== undefined) return { applied: false, refusal: unreadable };
    takenBack = [{ what: 'the ignore list it wrote', undo: await adapter.writeIgnoreList() }];
  } catch (err) {
    return refuse(err);
  }
  if (!adopting) {
    try {
      await initRepositoryIn(hostGit, instanceRoot);
    } catch (err) {
      return { applied: false, refusal: await refusalTakenBack(err, takenBack) };
    }
    takenBack = [{ what: 'the repository it made', undo: () => adapter.removeRepository() }, ...takenBack];
  }
  let pushRefusalNotWritten: string | undefined;
  try {
    takenBack = [{ what: 'the push check it wrote', undo: await adapter.refuseUnpublishedPins() }, ...takenBack];
  } catch (err) {
    if (!adopting) return { applied: false, refusal: await refusalTakenBack(err, takenBack) };
    pushRefusalNotWritten = errorMessage(err);
  }
  let pathTokensNotWritten: string | undefined;
  try {
    pathTokensNotWritten = await adapter.writePathTokens();
  } catch (err) {
    return { applied: false, refusal: await refusalTakenBack(err, takenBack) };
  }
  return {
    applied: true,
    ...(pushRefusalNotWritten === undefined ? {} : { pushRefusalNotWritten }),
    ...(pathTokensNotWritten === undefined ? {} : { pathTokensNotWritten }),
  };
}

/** The modlist gestures over the Instance adapter, and mEdit for a source mod's clone and build. */
export function instanceRepositoryCommands(deps: InstanceRepositoryCommandsDeps) {
  const { adapter } = deps;

  return {
    /** Makes the repository, or adopts the one the instance folder holds, with its ignore list, push refusal and path
     *  tokens, and writes no manifest. */
    gitInit: (): Promise<GitInitResult> => gitInit(deps),

    /** Each mod's manifest from the mod as it is; `everyMod`: the mods are every mod, so a source mod that is gone loses its
     *  submodule entry. */
    updateManifest: (
      mods: readonly string[], options: { onProgress?: (status: UpdateManifestStatus) => void; signal?: AbortSignal } = {}, others: readonly OtherManifest[] = [], everyMod = false, sourceMods: readonly string[],
    ): Promise<UpdateManifestResult> => updateManifest(deps, mods, options, others, everyMod, sourceMods),

    /** Keeps each file out of its mod's manifest, or puts it back, then records the manifest of each mod it changed. */
    ignoreFiles: (files: readonly FileToIgnore[], ignore: boolean) => ignoreFiles(deps, files, ignore),

    /** `everyManifest`: the mods are every mod, so a source mod whose folder its build has not made joins them. */
    restoreFromManifest: (
      mods: readonly string[], options: { onProgress?: (status: RestoreStatus) => void; signal?: AbortSignal } = {}, everyManifest = false, others: readonly OtherManifest[] = [],
    ): Promise<RestoreResult> => restoreFromManifest(deps, mods, options, everyManifest, others),

    otherManifests: (): Promise<OtherManifests> => otherManifestsOf(adapter),
  };
}

export type InstanceRepositoryCommands = ReturnType<typeof instanceRepositoryCommands>;
