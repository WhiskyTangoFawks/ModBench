// How MO2's implementation installs a mod: extracted inside the mod's own folder, then settled as
// its contents. An upgrade keeps its folder, so every watcher armed on it survives the release.

import { parseMetaIni, setOwnedKeysInText, writeMetaIni } from './codecs/metaIni';
import type { ArchiveReader } from './archiveReader';
import { copyTree, ensureDir, get, listDir, makeDir, makeTempDir, remove, rename, withLock, write } from './files';
import type { InstallPackage, InstanceAdapter, ModMeta, OwnedMetaKeys } from './instanceAdapter';
import { fileInFolder, manifestFileIn, modMetaFileIn, modsDir, newModExtractionPrefix, upgradeExtractionPrefix } from './layout';
import { errnoCode } from './errno';
import { errorMessage } from '../ports/errorMessage';
import { folderHolding, newModFolder, refuseFolderTaken, type Mo2Context } from './mo2Context';
import type { ReadingSource } from './mo2Reads';
import { releaseRoot } from './gameFolder/releaseRoot';

interface Extraction {
  readonly path: string;
  land(root: string, keys: OwnedMetaKeys): Promise<void>;
  abandon(): Promise<void>;
}

// A key the upgrade does not supply keeps the carried meta's own value.
function keysOver(keys: OwnedMetaKeys, carried: ModMeta): OwnedMetaKeys {
  return {
    gameName: keys.gameName,
    nexusId: keys.nexusId ?? carried.nexusId,
    version: keys.version ?? carried.version,
    archiveFilename: keys.archiveFilename ?? carried.archiveFilename,
    installedFiles: keys.installedFiles ?? carried.installedFiles,
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

export function mo2Landing(context: Mo2Context, archives: ArchiveReader, { settings }: Pick<ReadingSource, 'settings'>): Pick<InstanceAdapter, 'install'> {
  const fill = (installed: InstallPackage, path: string): Promise<void> =>
    (installed.kind === 'archive' ? archives.extract(installed.path, path) : copyTree(installed.path, path));

  return {
    // One lock per instance: two installs of one name must not both pass the name check.
    install: (installed, target, keys) => withLock(context.instanceRoot, async () => {
      const { gameName } = await settings();
      const holding = await folderHolding(context, { kind: 'mod', name: target.name });
      if ((target.kind === 'new') !== (holding === undefined)) return { landed: false };
      const extraction = holding === undefined ? await extractNewMod(context, target.name) : await extractUpgrade(target.name, holding.path, manifestFileIn(holding.path, holding.modName));
      try {
        await fill(installed, extraction.path);
        const { root, isFomod } = await releaseRoot(extraction.path);
        await extraction.land(root, { ...keys, gameName });
        return { landed: true, isFomod };
      } catch (err) {
        return abandonAfter(extraction, err);
      }
    }),
  };
}
