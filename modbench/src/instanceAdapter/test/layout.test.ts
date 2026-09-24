import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DOWNLOAD_SIDECAR_SUFFIX } from '../../mo2Codecs/downloads';
import { MOD_META_FILE_NAME } from '../../mo2Codecs/metaIni';
import { MODLIST_FILE_NAME, OVERWRITE_DIR_NAME } from '../../mo2Codecs/modlistText';
import { SETTINGS_FILE_NAME } from '../../mo2Codecs/modOrganizerIni';
import { PLUGINS_FILE_NAME } from '../../mo2Codecs/pluginsText';
import {
  MODLIST_GLOB,
  MODS_GLOB,
  OVERWRITE_GLOB,
  PLUGINS_GLOB,
  defaultDownloadsDir,
  downloadFile,
  downloadSidecarFile,
  modDir,
  modGitDir,
  modMetaFile,
  modlistFile,
  modsDir,
  overwriteDir,
  pluginsFile,
  profileDir,
  profilesDir,
  settingsFile,
} from '../layout';

const ROOT = join('/tmp', 'instance');

describe('MO2 layout', () => {
  it('names the four directories under the instance root', () => {
    expect(profilesDir(ROOT)).toBe(join(ROOT, 'profiles'));
    expect(modsDir(ROOT)).toBe(join(ROOT, 'mods'));
    expect(overwriteDir(ROOT)).toBe(join(ROOT, 'overwrite'));
    expect(defaultDownloadsDir(ROOT)).toBe(join(ROOT, 'downloads'));
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

  it('names a mod folder’s git directory, which is what tracked means (ADR-0007)', () => {
    expect(modGitDir(modDir(ROOT, 'Some Mod'))).toBe(join(ROOT, 'mods', 'Some Mod', '.git'));
  });

  it('names a mod folder and that mod’s meta file', () => {
    expect(modDir(ROOT, 'Some Mod')).toBe(join(ROOT, 'mods', 'Some Mod'));
    expect(modMetaFile(ROOT, 'Some Mod')).toBe(join(ROOT, 'mods', 'Some Mod', 'meta.ini'));
    expect(MOD_META_FILE_NAME).toBe('meta.ini');
  });

  it('names a download and its sidecar under the downloads folder it is given, not the instance root', () => {
    const downloadsDir = join('/mnt', 'elsewhere', 'MyDownloads'); // outside any instance
    expect(downloadFile(downloadsDir, 'Pack.7z')).toBe(join(downloadsDir, 'Pack.7z'));
    expect(downloadSidecarFile(downloadsDir, 'Pack.7z')).toBe(join(downloadsDir, 'Pack.7z.meta'));
    expect(DOWNLOAD_SIDECAR_SUFFIX).toBe('.meta');
  });

  it('names the overwrite directory as an origin value too (ADR-0012)', () => {
    expect(OVERWRITE_DIR_NAME).toBe('overwrite');
    expect(overwriteDir(ROOT)).toBe(join(ROOT, OVERWRITE_DIR_NAME));
  });

  // The watcher patterns are relative to the instance root and always POSIX-separated: VS Code's
  // `RelativePattern` takes a glob, not a platform path.
  it('names the watch patterns relative to the instance root', () => {
    expect(MODS_GLOB).toBe('mods/**');
    expect(OVERWRITE_GLOB).toBe('overwrite/**');
    expect(MODLIST_GLOB).toBe('profiles/*/modlist.txt');
    expect(PLUGINS_GLOB).toBe('profiles/*/plugins.txt');
  });

  it('joins a name with separators in it as one more path segment, never as a second argument', () => {
    expect(modDir(ROOT, 'A/B')).toBe(join(ROOT, 'mods', 'A/B'));
  });
});
