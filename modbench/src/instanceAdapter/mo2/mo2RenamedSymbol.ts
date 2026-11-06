// What another program's rename of a file or folder of MO2's renames, and the renames of a downloaded file and a
// profile that follow one.

import { basename, dirname } from 'node:path';
import { errorMessage } from '../../ports/errorMessage';
import { sameName, samePath } from '../../symbolNames/symbolNames';
import { isPluginFile } from '../../tables/pluginFile';
import { OVERWRITE_ORIGIN } from '../../wire/pluginAddress';
import { isInstallationFileName } from '../fileContents/installationFileNames';
import { exists, ignoreSkippedLink, listFolders, putIfChanged, readOrAbsent, rename, withLock } from '../files';
import type { InstanceAdapter } from '../instanceAdapter';
import { changeOwnedKeysInText, installationFileAt, parseMetaIni } from './codecs/metaIni';
import { selectedProfileAt, setSelectedProfileInText } from './codecs/modOrganizerIni';
import { entryNamed } from './codecs/modlistText';
import { downloadedFileMetadataPath, downloadedFilePath, modMetaFileIn, overwriteDir, profileDir, profilesDir, settingsFile } from './layout';
import { currentDownloadsDir, listModFolders, type Mo2Context } from './mo2Context';

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

export function mo2RenamedSymbol(context: Mo2Context): Pick<InstanceAdapter, 'renamedSymbol' | 'renameDownloadedFile' | 'renameProfile'> {
  const { instanceRoot } = context;
  return {
    async renamedSymbol(from, to) {
      const folder = dirname(from);
      if (!samePath(folder, dirname(to))) return undefined;
      if (samePath(folder, profilesDir(instanceRoot))) {
        const profiles = await readOrAbsent(() => listFolders(folder, ignoreSkippedLink), []);
        const profile = profiles.find((name) => samePath(profileDir(instanceRoot, name), from));
        return profile === undefined ? undefined : { kind: 'entry', entry: { kind: 'profile', name: profile }, to: { kind: 'profile', name: basename(to) } };
      }
      const downloadsDir = await currentDownloadsDir(context).catch(() => undefined);
      if (downloadsDir !== undefined && samePath(folder, downloadsDir)) {
        return isInstallationFileName(from) ? { kind: 'entry', entry: { kind: 'downloadedFile', name: basename(from) }, to: { kind: 'downloadedFile', name: basename(to) } } : undefined;
      }
      const folders = await listModFolders(context, ignoreSkippedLink) ?? [];
      const entry = folders.find(({ path }) => samePath(path, from));
      if (entry !== undefined) return { kind: 'entry', entry: { kind: entry.kind, name: entry.name }, to: entryNamed(basename(to)) };
      if (!isPluginFile(from)) return undefined;
      const origin = samePath(folder, overwriteDir(instanceRoot))
        ? OVERWRITE_ORIGIN
        : folders.find(({ kind, path }) => kind === 'mod' && samePath(path, folder))?.name;
      return origin === undefined ? undefined : { kind: 'plugin', plugin: { name: basename(from), origin }, to: basename(to) };
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
