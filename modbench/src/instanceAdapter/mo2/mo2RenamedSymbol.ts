// What another program's rename of a file or folder of MO2's renames, a Papyrus script's file included, and the renames
// of a downloaded file and a profile that follow one.

import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
import { errorMessage } from '../../ports/errorMessage';
import { sameName, samePath } from '../../symbolNames/symbolNames';
import { papyrusScriptAt } from '../../tables/gamePaths';
import { isPluginFile } from '../../tables/pluginFile';
import { OVERWRITE_ORIGIN } from '../../wire/pluginAddress';
import { isInstallationFileName } from '../fileContents/installationFileNames';
import { exists, ignoreSkippedLink, listFolders, putIfChanged, readOrAbsent, rename, textByStamp, withLock } from '../files';
import type { InstanceAdapter, RenamedSymbol } from '../instanceAdapter';
import { changeOwnedKeysInText, installationFileAt, parseMetaIni } from './codecs/metaIni';
import { selectedProfileAt, setSelectedProfileInText } from './codecs/modOrganizerIni';
import { entryNamed } from './codecs/modlistText';
import { downloadedFileMetadataPath, downloadedFilePath, modMetaFileIn, overwriteDir, profileDir, profilesDir, settingsFile } from './layout';
import { currentDownloadsDir, listModFolders, type Mo2Context } from './mo2Context';
import { gameOfSettings } from './mo2Game';

// A file or folder another program's rename has already moved counts as moved.
async function movedUnlessThere(from: string, to: string): Promise<boolean> {
  if (!await exists(from)) return false;
  if (!sameName(from, to) && await exists(to)) throw new Error(`"${to}" is in the way`);
  await rename(from, to);
  return true;
}

async function moved(from: string, to: string, notFound: string): Promise<void> {
  if (!await movedUnlessThere(from, to) && !await exists(to)) throw new Error(notFound);
}

async function followed(file: string, edit: (text: string) => string): Promise<string[]> {
  try {
    await putIfChanged(file, edit, { ifMissing: '' });
    return [];
  } catch (err) {
    return [`${file}: ${errorMessage(err)}`];
  }
}

function installedFrom(text: string, from: string, to: string): string {
  const named = installationFileAt(text);
  const value = parseMetaIni(text).installationFileName;
  if (named === undefined || value === undefined || !sameName(named.name, from)) return text;
  return changeOwnedKeysInText(text, { installationFileName: value.slice(0, value.length - named.name.length) + to });
}

// The path of `path` below `folder`, by the slashes the tables read; undefined when it is not below it.
function pathIn(folder: string, path: string): string | undefined {
  const below = relative(folder, path);
  return below === '' || below.split(sep)[0] === '..' || isAbsolute(below) ? undefined : below.split(sep).join('/');
}

export function mo2RenamedSymbol(context: Mo2Context): Pick<InstanceAdapter, 'renamedSymbol' | 'renameDownloadedFile' | 'renameProfile'> {
  const { instanceRoot } = context;
  // A plugin the game loads sits at its origin's root.
  const renamedInOrigin = async ({ origin, path }: { origin: string; path: string }, from: string, to: string): Promise<RenamedSymbol | undefined> => {
    const [inOrigin = '', renamedTo = ''] = [pathIn(path, from), pathIn(path, to)];
    if (!inOrigin.includes('/') && isPluginFile(inOrigin)) return { kind: 'plugin', plugin: { name: inOrigin, origin }, to: renamedTo };
    const { gameRelease } = gameOfSettings(await textByStamp(settingsFile(instanceRoot)));
    const [script, renamed] = [papyrusScriptAt(gameRelease, inOrigin), papyrusScriptAt(gameRelease, renamedTo)];
    return script && renamed && { kind: 'script', name: script.name, to: renamed.name };
  };
  return {
    async renamedSymbol(from, to) {
      const folder = dirname(from);
      if (!samePath(folder, dirname(to))) return undefined;
      if (samePath(folder, profilesDir(instanceRoot))) {
        const profiles = await readOrAbsent(() => listFolders(folder, ignoreSkippedLink), []);
        const profile = profiles.find((name) => samePath(profileDir(instanceRoot, name), from));
        return profile === undefined ? undefined : { kind: 'entry', entry: { kind: 'profile', name: profile }, to: { kind: 'profile', name: basename(to) } };
      }
      const folders = await listModFolders(context, ignoreSkippedLink) ?? [];
      const entry = folders.find(({ path }) => samePath(path, from));
      if (entry !== undefined) return { kind: 'entry', entry: { kind: entry.kind, name: entry.name }, to: entryNamed(basename(to)) };
      const origins = [{ origin: OVERWRITE_ORIGIN, path: overwriteDir(instanceRoot) }, ...folders.flatMap(({ kind, name, path }) => (kind === 'mod' ? [{ origin: name, path }] : []))];
      const holder = origins.find(({ path }) => pathIn(path, from) !== undefined);
      if (holder !== undefined) return renamedInOrigin(holder, from, to);
      if (!isInstallationFileName(from)) return undefined;
      return samePath(folder, await currentDownloadsDir(context))
        ? { kind: 'entry', entry: { kind: 'downloadedFile', name: basename(from) }, to: { kind: 'downloadedFile', name: basename(to) } }
        : undefined;
    },
    async renameDownloadedFile(from, to) {
      const downloadsDir = await currentDownloadsDir(context);
      await moved(downloadedFilePath(downloadsDir, from), downloadedFilePath(downloadsDir, to), `Not a downloaded file: ${from}`);
      const metadata = downloadedFileMetadataPath(downloadsDir, from);
      await withLock(metadata, () => movedUnlessThere(metadata, downloadedFileMetadataPath(downloadsDir, to)));
      const mods = (await listModFolders(context, ignoreSkippedLink) ?? []).filter(({ kind }) => kind === 'mod');
      return (await Promise.all(mods.map(({ path }) => followed(modMetaFileIn(path), (text) => installedFrom(text, from, to))))).flat();
    },
    async renameProfile(from, to) {
      await moved(profileDir(instanceRoot, from), profileDir(instanceRoot, to), `No profile "${from}"`);
      return followed(settingsFile(instanceRoot), (text) => {
        const selected = selectedProfileAt(text);
        return selected !== undefined && sameName(selected.name, from) ? setSelectedProfileInText(text, to) : text;
      });
    },
  };
}
