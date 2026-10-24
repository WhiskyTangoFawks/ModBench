// How MO2's implementation installs a mod: extracted inside the mod's own folder, then settled as
// its contents. An upgrade keeps its folder, so every watcher armed on it survives the release.

import { effectiveModId } from './codecs/nexusFileName';
import { type MetaIni, metaIniOf, type OwnedMetaKeys, parseMetaIni, setOwnedKeysInText, writeMetaIni } from './codecs/metaIni';
import type { InstallationFileReader } from '../downloadedFileContents/installationFileReader';
import { copyTree, ensureDir, get, listDir, makeDir, makeTempDir, remove, rename, withLock, write } from '../files';
import { fileInFolder, type InstallPackage, type InstallTarget, InstanceAdapter, type ModFolder } from '../instanceAdapter';
import { manifestFileIn, modMetaFileIn, modsDir, newModExtractionPrefix, upgradeExtractionPrefix } from './layout';
import { errnoCode } from '../errno';
import { errorMessage } from '../../ports/errorMessage';
import { folderHolding, newModFolder, refuseFolderTaken, type Mo2Context } from './mo2Context';
import type { ReadingSource } from '../instanceReading';
import { releaseRoot } from '../gameFolder/releaseRoot';
import { fomodLanding, type FomodEngine } from '../fomodInstaller/fomodInstaller';
import { conditionFacts } from '../fomodInstaller/conditionFacts';

interface Extraction {
  readonly path: string;
  land(root: string, keys: OwnedMetaKeys): Promise<void>;
  abandon(): Promise<void>;
}

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

// The release's root entries move up into the mod's folder; the rest of the extraction goes.
async function settleInto(folder: string, extraction: string, root: string, metaText: string): Promise<void> {
  for (const { name } of await listDir(root)) await rename(fileInFolder(root, name), fileInFolder(folder, name));
  await remove(extraction);
  await write(modMetaFileIn(folder), metaText);
}

async function extractNewMod(context: Mo2Context, mod: string): Promise<Extraction> {
  const folder = newModFolder(context, mod);
  await refuseFolderTaken(context, { kind: 'mod', name: mod }, folder);
  await ensureDir(modsDir(context.instanceRoot));
  try {
    await makeDir(folder);
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') throw new Error(`The folder "${folder}" is in the way`, { cause: err });
    throw err;
  }
  const path = await makeTempDir(newModExtractionPrefix(folder));
  return {
    path,
    land: (root, keys) => settleInto(folder, path, root, writeMetaIni(keys)),
    abandon: () => remove(folder),
  };
}

async function upgradeLanding(folder: string, extraction: string, root: string, keys: OwnedMetaKeys, manifest: string): Promise<void> {
  const carried = await get(modMetaFileIn(folder), '');
  for (const { name } of await listDir(folder)) {
    const entry = fileInFolder(folder, name);
    if (entry !== extraction && entry !== manifest) await remove(entry);
  }
  await settleInto(folder, extraction, root, setOwnedKeysInText(carried, keysOver(keys, parseMetaIni(carried))));
}

async function extractUpgrade(mod: string, folder: string, manifest: string): Promise<Extraction> {
  const path = await makeTempDir(upgradeExtractionPrefix(folder));
  return {
    path,
    async land(root, keys) {
      try {
        await upgradeLanding(folder, path, root, keys, manifest);
      } catch (err) {
        throw new Error(`Upgrading "${mod}" failed partway and was not rolled back: ${errorMessage(err)}`, { cause: err });
      }
    },
    abandon: () => remove(path),
  };
}

async function abandonAfter(extraction: Extraction, failure: unknown): Promise<never> {
  try {
    await extraction.abandon();
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

  // A mod with an install in flight takes no second one, so one landing never clears another's extraction.
  const claimedMods = claimedModsOf(context.instanceRoot);

  // The lock serializes the writes to the instance, so it is held to claim the target and to land, and not while the
  // release is extracted or a user answers the installer.
  const claim = (target: InstallTarget): Promise<{ extraction: Extraction; holding: ModFolder | undefined } | undefined> =>
    withLock(context.instanceRoot, async () => {
      const holding = await folderHolding(context, { kind: 'mod', name: target.name });
      if ((target.kind === 'new') !== (holding === undefined) || claimedMods.has(target.name.toLowerCase())) return undefined;
      const extraction = holding === undefined ? await extractNewMod(context, target.name) : await extractUpgrade(target.name, holding.path, manifestFileIn(holding.path, holding.modName));
      claimedMods.add(target.name.toLowerCase());
      return { extraction, holding };
    });

  // The folder the claim was made on is still there, as the claim found it.
  const claimHolds = async (target: InstallTarget, claimed: ModFolder | undefined): Promise<boolean> => {
    const now = await folderHolding(context, { kind: 'mod', name: target.name });
    return target.kind === 'new' ? now !== undefined : now?.path === claimed?.path;
  };

  return {
    install: async (installed, target, keys, answer) => {
      const { gameName } = await source.settings();
      const claimed = await claim(target);
      if (claimed === undefined) return { landed: false };
      const { extraction, holding } = claimed;
      try {
        await fill(installed, extraction.path);
        const release = await releaseRoot(extraction.path);
        const landing = release.fomod === undefined
          ? { root: release.root, fomod: undefined }
          : await fomodLanding(fomodEngine, { root: release.root, fomod: release.fomod }, answer, () => conditionFacts(source));
        return await withLock(context.instanceRoot, async () => {
          if ('cancelled' in landing || !(await claimHolds(target, holding))) {
            await extraction.abandon();
            return 'cancelled' in landing ? { landed: false, cancelled: true } : { landed: false };
          }
          const { root, fomod } = landing;
          await extraction.land(root, { ...metaIniOf(keys), nexusId: effectiveModId(keys.nexusId, keys.installationFileName), gameName });
          return fomod === undefined ? { landed: true } : { landed: true, fomod };
        });
      } catch (err) {
        return await abandonAfter(extraction, err);
      } finally {
        claimedMods.delete(target.name.toLowerCase());
      }
    },
  };
}
