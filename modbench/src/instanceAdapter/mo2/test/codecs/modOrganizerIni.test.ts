import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../../test/mo2/fakeVscodeWatcher';
import { mo2InstanceHolding, type HeldInstance } from '../../../test/instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

const SETTINGS = String.raw`[General]
gameName=Fallout 4
selected_profile=@ByteArray(Default)
gamePath=@ByteArray(Z:\\\\path\\to\\Stock Game Folder)

[Settings]
language=en
`.replaceAll('\n', '\r\n');

const withSettings = (text: string): HeldInstance => mo2InstanceHolding({ 'ModOrganizer.ini': text });

const gamePathLook = async (gamePathLine: string) => {
  const folder = await withSettings(`[General]\r\ngameName=Fallout 4\r\nselected_profile=Default\r\n${gamePathLine}`).adapter.gameFolder();
  return folder.kind === 'notFound' ? folder.looked.find(({ place }) => place === 'ModOrganizer.ini\'s gamePath')?.answer : folder;
};

const downloadsDirOf = async (settings: string): Promise<{ root: string; downloadsDir: string | undefined }> => {
  const { root, adapter } = withSettings(`[General]\r\ngameName=Fallout 4\r\nselected_profile=Default\r\n${settings}`);
  const { downloadedFiles } = await adapter.reading();
  return { root, downloadsDir: downloadedFiles.kind === 'listed' ? downloadedFiles.downloadsDir : undefined };
};

describe('the selected profile ModOrganizer.ini names', () => {
  it('unwraps an @ByteArray(...) value', async () => {
    expect(await withSettings(SETTINGS).adapter.activeProfile()).toBe('Default');
  });

  it('reads a plain (non-@ByteArray) value', async () => {
    expect(await withSettings('[General]\r\ngameName=Fallout 4\r\nselected_profile=My Profile\r\n').adapter.activeProfile()).toBe('My Profile');
  });

  it('throws a message naming the missing key when the key is absent', async () => {
    await expect(withSettings('[General]\r\ngameName=Fallout 4\r\n').adapter.activeProfile()).rejects.toThrow(/missing selected_profile/);
  });
});

describe('section-aware lookup', () => {
  it('does not find a key that exists only in another section', async () => {
    await expect(withSettings('[General]\r\ngameName=Fallout 4\r\n[Settings]\r\nselected_profile=Wrong\r\n').adapter.activeProfile())
      .rejects.toThrow(/missing selected_profile/);
  });
});

describe('the game name ModOrganizer.ini names', () => {
  it('throws a message naming the missing key when gameName is absent', async () => {
    await expect(withSettings('[General]\r\nselected_profile=Default\r\n').adapter.gameRelease()).rejects.toThrow(/missing gameName/);
  });
});

describe('the game path ModOrganizer.ini names', () => {
  it('unwraps an @ByteArray(...) value', async () => {
    const { root, adapter } = mo2InstanceHolding();
    const game = join(root, 'game');
    mkdirSync(join(game, 'Data'), { recursive: true });
    writeFileSync(join(root, 'ModOrganizer.ini'), `[General]\r\ngameName=Fallout 4\r\nselected_profile=Default\r\ngamePath=@ByteArray(${game.replaceAll('\\', '/')})\r\n`);

    expect(await adapter.gameFolder()).toEqual({ kind: 'found', root: game, dataFolder: join(game, 'Data') });
  });

  it('reads a plain (non-@ByteArray) value, un-escaping its doubled backslashes', async () => {
    expect(await gamePathLook(String.raw`gamePath=Games\\Fallout4` + '\r\n')).toBe(`${join('Games', 'Fallout4')} has no Data folder`);
  });

  it('reads as not set when the key is absent', async () => {
    expect(await gamePathLook('')).toBe('not set');
  });
});

describe('the download directory ModOrganizer.ini names', () => {
  it.each([
    ['answers the instance\'s own downloads folder when the key is absent, so MO2\'s own default applies', '[Settings]\r\nlanguage=en\r\n', ['downloads']],
    ['un-escapes the doubled backslashes MO2/Qt actually writes for a plain Windows path, download_directory being a plain QString (settings.cpp:1683), never @ByteArray unlike gamePath',
      String.raw`[Settings]` + '\r\n' + String.raw`download_directory=dl\\sub` + '\r\n', ['dl', 'sub']],
    ['unwraps an @ByteArray(...) value holding no escapes', '[Settings]\r\ndownload_directory=@ByteArray(%BASE_DIR%/downloads)\r\n', ['downloads']],
    ['reads an empty value as unset, as MO2\'s own default-path behaviour does, its settings dialog removing the key rather than writing it empty (setConfigurablePath)',
      '[Settings]\r\ndownload_directory=\r\n', ['downloads']],
  ])('%s', async (_, settings, below) => {
    const { root, downloadsDir } = await downloadsDirOf(settings);
    expect(downloadsDir).toBe(join(root, ...below));
  });
});

describe('the selected profile written to ModOrganizer.ini, every other byte kept', () => {
  it.each(['a,b', 'back\\slash', 'say "hi"', ' padded '])('writes %j so that readSelectedProfile reads it back', async (name) => {
    const { adapter } = withSettings(SETTINGS);
    await adapter.selectProfile(name);
    expect(await adapter.activeProfile()).toBe(name);
  });

  it('rewrites only the selected_profile value, preserving every other byte', async () => {
    const { adapter, text } = withSettings(SETTINGS);
    await adapter.selectProfile('Secondary');
    expect(await text('ModOrganizer.ini')).toBe(SETTINGS.replace('@ByteArray(Default)', '@ByteArray(Secondary)'));
  });

  it('is a no-op (identical bytes) when setting the current profile', async () => {
    const { adapter, text } = withSettings(SETTINGS);
    expect(await adapter.selectProfile('Default')).toEqual({ wrote: false });
    expect(await text('ModOrganizer.ini')).toBe(SETTINGS);
  });

  it('throws a message naming the missing key when selected_profile is absent', async () => {
    await expect(withSettings('[General]\r\ngameName=Fallout 4\r\n').adapter.selectProfile('X')).rejects.toThrow(/missing selected_profile/);
  });
});
