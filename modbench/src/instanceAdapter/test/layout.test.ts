import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DOWNLOAD_SIDECAR_SUFFIX } from '../codecs/downloads';
import { MOD_META_FILE_NAME } from '../codecs/metaIni';
import { MODLIST_FILE_NAME, OVERWRITE_DIR_NAME } from '../codecs/modlistText';
import { SETTINGS_FILE_NAME } from '../codecs/modOrganizerIni';
import { PLUGINS_FILE_NAME } from '../../loadOrderFileCodec/pluginsText';
import {
  DOWNLOADS_WATCH_GLOB,
  MODLIST_GLOB,
  MODS_GLOB,
  OVERWRITE_GLOB,
  PLUGINS_GLOB,
  defaultDownloadsDir,
  downloadFile,
  downloadNameAt,
  downloadSidecarFile,
  modDir,
  modGitDir,
  modMetaFile,
  modlistFile,
  modsDir,
  overwriteDir,
  fileInFolder,
  isInFolder,
  pluginsFile,
  profileDir,
  profilesDir,
  settingsFile,
} from '../layout';

const ROOT = join('/tmp', 'instance');

describe('MO2 layout', () => {
  it('names the downloaded file at a path as the platform matches paths, not by exact comparison, which misses the path a Windows picker hands back in another case', () => {
    expect(downloadNameAt('C:\\MO2\\downloads', 'c:\\mo2\\Downloads\\Foo.7z', 'win32')).toBe('Foo.7z');
    expect(downloadNameAt('/mo2/downloads', '/mo2/downloads/Foo.7z', 'linux')).toBe('Foo.7z');
    expect(downloadNameAt('/mo2/downloads', '/mo2/Downloads/Foo.7z', 'linux')).toBeUndefined();
    expect(downloadNameAt('C:\\MO2\\downloads', 'C:\\Elsewhere\\Foo.7z', 'win32')).toBeUndefined();
  });

  it('names the four directories under the instance root', () => {
    expect(profilesDir(ROOT)).toBe(join(ROOT, 'profiles'));
    expect(modsDir(ROOT)).toBe(join(ROOT, 'mods'));
    expect(overwriteDir(ROOT)).toBe(join(ROOT, 'overwrite'));
    expect(defaultDownloadsDir(ROOT)).toBe(join(ROOT, 'downloads'));
  });

  it('names a file inside a folder by its relative path', () => {
    expect(fileInFolder(join(ROOT, 'mods', 'SomeMod'), 'plugin-source/Some.esp/x.json'))
      .toBe(join(ROOT, 'mods', 'SomeMod', 'plugin-source', 'Some.esp', 'x.json'));
  });

  it('holds a file anywhere beneath a folder, and never one in a sibling whose name it prefixes', () => {
    const folder = join(ROOT, 'mods', 'SomeMod');
    expect(isInFolder(folder, join(folder, 'plugin-source', 'x.json'))).toBe(true);
    expect(isInFolder(folder, join(ROOT, 'mods', 'SomeMod2', 'x.json'))).toBe(false);
  });

  it('names the settings file', () => {
    expect(settingsFile(ROOT)).toBe(join(ROOT, 'ModOrganizer.ini'));
    expect(SETTINGS_FILE_NAME).toBe('ModOrganizer.ini');
  });

  it('names a profile directory and the two files a profile holds, each codec naming its own', () => {
    expect(profileDir(ROOT, 'Default')).toBe(join(ROOT, 'profiles', 'Default'));
    expect(modlistFile(ROOT, 'Default')).toBe(join(ROOT, 'profiles', 'Default', MODLIST_FILE_NAME));
    expect(pluginsFile(ROOT, 'Default')).toBe(join(ROOT, 'profiles', 'Default', PLUGINS_FILE_NAME));
    expect([MODLIST_FILE_NAME, PLUGINS_FILE_NAME]).toEqual(['modlist.txt', 'plugins.txt']);
  });

  it('names a mod folder’s git directory, which is what tracked means', () => {
    expect(modGitDir(modDir(ROOT, 'Some Mod'))).toBe(join(ROOT, 'mods', 'Some Mod', '.git'));
  });

  it('names a mod folder and that mod’s meta file', () => {
    expect(modDir(ROOT, 'Some Mod')).toBe(join(ROOT, 'mods', 'Some Mod'));
    expect(modMetaFile(ROOT, 'Some Mod')).toBe(join(ROOT, 'mods', 'Some Mod', 'meta.ini'));
    expect(MOD_META_FILE_NAME).toBe('meta.ini');
  });

  it('names a download and its sidecar under the downloads folder it is given, not the instance root', () => {
    const downloadsDirOutsideAnyInstance = join('/mnt', 'elsewhere', 'MyDownloads');
    expect(downloadFile(downloadsDirOutsideAnyInstance, 'Pack.7z')).toBe(join(downloadsDirOutsideAnyInstance, 'Pack.7z'));
    expect(downloadSidecarFile(downloadsDirOutsideAnyInstance, 'Pack.7z')).toBe(join(downloadsDirOutsideAnyInstance, 'Pack.7z.meta'));
    expect(DOWNLOAD_SIDECAR_SUFFIX).toBe('.meta');
  });

  it('names the overwrite directory as an origin value too', () => {
    expect(OVERWRITE_DIR_NAME).toBe('overwrite');
    expect(overwriteDir(ROOT)).toBe(join(ROOT, OVERWRITE_DIR_NAME));
  });

  it('names the watch patterns relative to the instance root, always POSIX-separated as VS Code\'s `RelativePattern` takes a glob, not a platform path', () => {
    expect(MODS_GLOB).toBe('mods/**');
    expect(OVERWRITE_GLOB).toBe('overwrite/**');
    expect(MODLIST_GLOB).toBe('profiles/*/modlist.txt');
    expect(PLUGINS_GLOB).toBe('profiles/*/plugins.txt');
  });

  it('names downloads\' own watch glob as everything under its base, not an instance-relative segment, the base being the resolved downloads folder itself and never the instance root', () => {
    expect(DOWNLOADS_WATCH_GLOB).toBe('**');
  });

  it('joins a name with separators in it as one more path segment, never as a second argument', () => {
    expect(modDir(ROOT, 'A/B')).toBe(join(ROOT, 'mods', 'A/B'));
  });
});
