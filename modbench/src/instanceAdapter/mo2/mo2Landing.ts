// How MO2's implementation installs a mod: extracted in a staging folder of its own, then settled as the mod's
// contents. An upgrade keeps its folder, so every watcher armed on it survives the release.

import { effectiveModId } from './codecs/nexusFileName';
import { type MetaIni, metaIniOf, type OwnedMetaKeys, parseMetaIni, setOwnedKeysInText, writeMetaIni } from './codecs/metaIni';
import type { InstallationFileReader } from '../downloadedFileContents/installationFileReader';
import { copyTree, ensureDir, get, listDir, makeDir, makeTempDir, remove, rename, withLock, write } from '../files';
import { fileInFolder, type InstallPackage, type InstallTarget, InstanceAdapter, type ModFolder } from '../instanceAdapter';
import { manifestFileIn, modMetaFileIn, modsDir, stagingPrefix } from './layout';
import { errnoCode } from '../../ports/errno';
import { errorMessage } from '../../ports/errorMessage';
import { folderHolding, newModFolder, refuseFolderTaken, type Mo2Context } from './mo2Context';
import type { ReadingSource } from '../instanceReading';
import { releaseRoot } from '../gameFolder/releaseRoot';
import { fomodLanding, type FomodEngine } from '../fomodInstaller/fomodInstaller';
import { conditionFacts } from '../fomodInstaller/conditionFacts';

type Land = (root: string, keys: OwnedMetaKeys) => Promise<void>;

// A key the upgrade does not supply keeps the carried meta's own value.
function keysOver(keys: OwnedMetaKeys, carried: MetaIni): OwnedMetaKeys {
  return {
    gameName: keys.gameName,
    nexusId: keys.nexusId ?? carried.nexusId,
    version: keys.version ?? carried.version,
    installationFileName: keys.installationFileName ?? carried.installationFileName,
    installedFiles: keys.installedFiles ?? carried.installedFiles,
    nexusFileStatus: keys.nexusFileStatus ?? carried.nexusFileStatus,
  };
}

// A folder on another volume cannot be renamed into place, so it is copied there.
async function moveEntry(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if (errnoCode(err) !== 'EXDEV') throw err;
    await copyTree(from, to);
    await remove(from);
  }
}

async function settleInto(folder: string, root: string, metaText: string): Promise<void> {
  for (const { name } of await listDir(root)) await moveEntry(fileInFolder(root, name), fileInFolder(folder, name));
  await write(modMetaFileIn(folder), metaText);
}

const landNewMod = (context: Mo2Context, mod: string): Land => async (root, keys) => {
  const folder = newModFolder(context, mod);
  await refuseFolderTaken(context, { kind: 'mod', name: mod }, folder);
  await ensureDir(modsDir(context.instanceRoot));
  try {
    await makeDir(folder);
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') throw new Error(`The folder "${folder}" is in the way`, { cause: err });
    throw err;
  }
  try {
    await settleInto(folder, root, writeMetaIni(keys));
  } catch (err) {
    await remove(folder);
    throw err;
  }
};

const landUpgrade = (mod: string, folder: string, manifest: string): Land => async (root, keys) => {
  try {
    const carried = await get(modMetaFileIn(folder), '');
    for (const { name } of await listDir(folder)) {
      const entry = fileInFolder(folder, name);
      if (entry !== manifest) await remove(entry);
    }
    await settleInto(folder, root, setOwnedKeysInText(carried, keysOver(keys, parseMetaIni(carried))));
  } catch (err) {
    throw new Error(`Upgrading "${mod}" failed partway and was not rolled back: ${errorMessage(err)}`, { cause: err });
  }
};

async function abandonAfter(abandon: () => Promise<void>, failure: unknown): Promise<never> {
  try {
    await abandon();
  } catch (err) {
    throw new Error(`${errorMessage(failure)} Removing what the install left behind failed too: ${errorMessage(err)}`, { cause: failure });
  }
  throw failure;
}

const claimedModsByInstance = new Map<string, Set<string>>();

function claimedModsOf(instanceRoot: string): Set<string> {
  const known = claimedModsByInstance.get(instanceRoot);
  if (known !== undefined) return known;
  const made = new Set<string>();
  claimedModsByInstance.set(instanceRoot, made);
  return made;
}

export function mo2Landing(
  context: Mo2Context, installationFileReader: InstallationFileReader, source: ReadingSource, fomodEngine: FomodEngine,
): Pick<InstanceAdapter, 'install'> {
  const fill = (installed: InstallPackage, path: string): Promise<void> =>
    (installed.kind === 'archive' ? installationFileReader.extract(installed.path, path) : copyTree(installed.path, path));

  // A mod with an install in flight takes no second one, so one landing never clears another's files.
  const claimedMods = claimedModsOf(context.instanceRoot);

  // The lock is held to claim the target and to land, not while the release is extracted or a user answers the
  // installer. Nothing is written to the instance between the two.
  const claim = (target: InstallTarget): Promise<{ readonly holding: ModFolder | undefined } | undefined> =>
    withLock(context.instanceRoot, async () => {
      const holding = await folderHolding(context, { kind: 'mod', name: target.name });
      if ((target.kind === 'new') !== (holding === undefined) || claimedMods.has(target.name.toLowerCase())) return undefined;
      claimedMods.add(target.name.toLowerCase());
      return { holding };
    });

  const claimHolds = async (target: InstallTarget, claimed: ModFolder | undefined): Promise<boolean> => {
    const now = await folderHolding(context, { kind: 'mod', name: target.name });
    return target.kind === 'new' ? now === undefined : now?.path === claimed?.path;
  };

  return {
    install: async (installed, target, keys, answer) => {
      const { gameName } = await source.settings();
      const claimed = await claim(target);
      if (claimed === undefined) return { landed: false };
      try {
        const staging = await makeTempDir(stagingPrefix(context.instanceRoot));
        try {
          await fill(installed, staging);
          const release = await releaseRoot(staging);
          const landing = release.fomod === undefined
            ? { kind: 'landing' as const, root: release.root, fomod: undefined }
            : await fomodLanding(fomodEngine, { root: release.root, fomod: release.fomod }, answer, () => conditionFacts(source));
          const outcome = await withLock(context.instanceRoot, async () => {
            if (landing.kind === 'cancelled') return { landed: false as const, cancelled: true as const };
            if (!(await claimHolds(target, claimed.holding))) return { landed: false as const };
            const land = claimed.holding === undefined
              ? landNewMod(context, target.name)
              : landUpgrade(target.name, claimed.holding.path, manifestFileIn(claimed.holding.path, claimed.holding.modName));
            await land(landing.root, { ...metaIniOf(keys), nexusId: effectiveModId(keys.nexusId, keys.installationFileName), gameName });
            return landing.fomod === undefined ? { landed: true as const } : { landed: true as const, fomod: landing.fomod };
          });
          await remove(staging);
          return outcome;
        } catch (err) {
          return await abandonAfter(() => remove(staging), err);
        }
      } finally {
        claimedMods.delete(target.name.toLowerCase());
      }
    },
  };
}
