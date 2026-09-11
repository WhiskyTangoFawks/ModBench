import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  DOWNLOADS_GLOB,
  DOWNLOAD_SIDECAR_SUFFIX,
  MODLIST_GLOB,
  MODS_GLOB,
  MOD_META_FILE_NAME,
  OVERWRITE_DIR_NAME,
  OVERWRITE_GLOB,
  PLUGINS_GLOB,
  SETTINGS_FILE_NAME,
  downloadFile,
  downloadSidecarFile,
  downloadsDir,
  modDir,
  modMetaFile,
  modlistFile,
  modsDir,
  overwriteDir,
  pluginsFile,
  profileDir,
  profilesDir,
  settingsFile,
} from './layout';

const ROOT = join('/tmp', 'instance');

describe('MO2 layout', () => {
  it('names the four directories under the instance root', () => {
    expect(profilesDir(ROOT)).toBe(join(ROOT, 'profiles'));
    expect(modsDir(ROOT)).toBe(join(ROOT, 'mods'));
    expect(overwriteDir(ROOT)).toBe(join(ROOT, 'overwrite'));
    expect(downloadsDir(ROOT)).toBe(join(ROOT, 'downloads'));
  });

  it('names the settings file', () => {
    expect(settingsFile(ROOT)).toBe(join(ROOT, 'ModOrganizer.ini'));
    expect(SETTINGS_FILE_NAME).toBe('ModOrganizer.ini');
  });

  it('names a profile directory and the two files a profile holds', () => {
    expect(profileDir(ROOT, 'Default')).toBe(join(ROOT, 'profiles', 'Default'));
    expect(modlistFile(ROOT, 'Default')).toBe(join(ROOT, 'profiles', 'Default', 'modlist.txt'));
    expect(pluginsFile(ROOT, 'Default')).toBe(join(ROOT, 'profiles', 'Default', 'plugins.txt'));
  });

  it('names a mod folder and that mod’s meta file', () => {
    expect(modDir(ROOT, 'Some Mod')).toBe(join(ROOT, 'mods', 'Some Mod'));
    expect(modMetaFile(ROOT, 'Some Mod')).toBe(join(ROOT, 'mods', 'Some Mod', 'meta.ini'));
    expect(MOD_META_FILE_NAME).toBe('meta.ini');
  });

  it('names a download and its sidecar', () => {
    expect(downloadFile(ROOT, 'Pack.7z')).toBe(join(ROOT, 'downloads', 'Pack.7z'));
    expect(downloadSidecarFile(ROOT, 'Pack.7z')).toBe(join(ROOT, 'downloads', 'Pack.7z.meta'));
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
    expect(DOWNLOADS_GLOB).toBe('downloads/**');
    expect(MODLIST_GLOB).toBe('profiles/*/modlist.txt');
    expect(PLUGINS_GLOB).toBe('profiles/*/plugins.txt');
  });

  it('joins a name with separators in it as one more path segment, never as a second argument', () => {
    expect(modDir(ROOT, 'A/B')).toBe(join(ROOT, 'mods', 'A/B'));
  });
});
