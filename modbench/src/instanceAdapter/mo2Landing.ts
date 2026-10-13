// How MO2's implementation installs a mod: extracted inside the mod's own folder, then settled as
// its contents. An upgrade keeps its folder, so every watcher armed on it survives the release.

import { parseMetaIni, setOwnedKeysInText, writeMetaIni } from './codecs/metaIni';
import type { ArchiveReader } from './archiveReader';
import { copyTree, ensureDir, get, listDir, makeDir, makeTempDir, remove, rename, write } from './files';
import type { InstallSource, InstanceAdapter, ModMeta, OwnedMetaKeys } from './instanceAdapter';
import { fileInFolder, modMetaFileIn, modsDir, newModExtractionPrefix, upgradeExtractionPrefix } from './layout';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';
import { folderHolding, newModFolder, refuseFolderTaken, type Mo2Context } from './mo2Context';
import { releaseRoot } from './releaseRoot';

// A release on its way into a mod's folder, in a fresh folder of its own inside it.
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

async function upgradeLanding(folder: string, extraction: string, root: string, keys: OwnedMetaKeys): Promise<void> {
  const carried = await get(modMetaFileIn(folder), '');
  for (const { name } of await listDir(folder)) {
    const entry = fileInFolder(folder, name);
    if (entry !== extraction) await remove(entry);
  }
  await settleInto(folder, extraction, root, setOwnedKeysInText(carried, keysOver(keys, parseMetaIni(carried))));
}

async function extractUpgrade(mod: string, folder: string): Promise<Extraction> {
  const path = await makeTempDir(upgradeExtractionPrefix(folder));
  return {
    path,
    async land(root, keys) {
      try {
        await upgradeLanding(folder, path, root, keys);
      } catch (err) {
        throw new Error(`Upgrading "${mod}" failed partway and was not rolled back: ${errorMessage(err)}`, { cause: err });
      }
    },
    abandon: () => remove(path),
  };
}

// Serialized per instance root: the folder check and the folder's making must not interleave
// with another install, or two of the same name both pass the check.
const installQueues = new Map<string, Promise<unknown>>();

function withInstallLock<T>(instanceRoot: string, task: () => Promise<T>): Promise<T> {
  const prior = installQueues.get(instanceRoot) ?? Promise.resolve();
  const next = prior.then(task, task);
  installQueues.set(instanceRoot, next.catch(() => undefined));
  return next;
}

async function abandonAfter(extraction: Extraction, failure: unknown): Promise<never> {
  try {
    await extraction.abandon();
  } catch (err) {
    throw new Error(`${errorMessage(failure)} Removing what the install left behind failed too: ${errorMessage(err)}`, { cause: failure });
  }
  throw failure;
}

export function mo2Landing(context: Mo2Context, archives: ArchiveReader): Pick<InstanceAdapter, 'install'> {
  const fill = (source: InstallSource, path: string): Promise<void> =>
    (source.kind === 'archive' ? archives.extract(source.path, path) : copyTree(source.path, path));

  return {
    install: (source, target, keys) => withInstallLock(context.instanceRoot, async () => {
      const holding = await folderHolding(context, { kind: 'mod', name: target.name });
      if ((target.kind === 'new') !== (holding === undefined)) return { landed: false };
      const extraction = holding === undefined ? await extractNewMod(context, target.name) : await extractUpgrade(target.name, holding.path);
      try {
        await fill(source, extraction.path);
        const { root, isFomod } = await releaseRoot(extraction.path);
        await extraction.land(root, keys);
        return { landed: true, isFomod };
      } catch (err) {
        return abandonAfter(extraction, err);
      }
    }),
  };
}
