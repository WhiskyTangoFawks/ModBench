import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import type { FileOrigin, InstanceAdapter } from '../instanceAdapter';
import { implementationsOver, pluginOrderOf, type Subject } from './adapterContract';

const ALPHA: FileOrigin = { kind: 'mod', name: 'Alpha' };
const BETA: FileOrigin = { kind: 'mod', name: 'Beta' };
const GAMMA: FileOrigin = { kind: 'mod', name: 'Gamma' };
const trash = (path: string): Promise<void> => rm(path, { recursive: true, force: true });

describe.each(implementationsOver('holdings-instance'))('$name holds the contract of what the instance holds', (implementation) => {
  let subject: Subject;
  let adapter: InstanceAdapter;
  beforeEach(async () => {
    subject = await implementation.subject();
    adapter = subject.adapter;
  });
  afterEach(() => subject.dispose());

  const folderNames = async (): Promise<string[]> => ((await adapter.reading()).modFolders?.all ?? []).map((folder) => folder.name).sort();
  const downloadedNames = async (): Promise<string[]> => {
    const { downloadedFiles } = await adapter.reading();
    return downloadedFiles.kind === 'listed' ? (downloadedFiles.files ?? []).map((file) => file.name) : [];
  };
  const downloadedFile = async (name: string) => {
    const { downloadedFiles } = await adapter.reading();
    return downloadedFiles.kind === 'listed' ? downloadedFiles.files?.find((file) => file.name === name) : undefined;
  };
  const filesOf = async (origin: FileOrigin): Promise<string[]> => {
    const { modFiles } = await adapter.reading();
    return (origin.kind === 'mod' ? modFiles.get(origin.name)?.files ?? [] : []).map((file) => file.relativePath).sort();
  };

  describe('mod folders', () => {
    it('gives no folder to a name that reaches outside the mods folder', async () => {
      expect(await adapter.modFolderPath('Vanished/Mod')).toBeUndefined();
      const held = await adapter.modFolderPath('Alpha');
      expect(normalize(await adapter.modFolderPath('Nope') ?? '')).toBe(join(dirname(held ?? ''), 'Nope'));
    });

    it('refuses to create a folder that is there, in any case', async () => {
      await expect(adapter.createModFolder('alpha')).rejects.toThrow(/is in the way/);
      expect(await folderNames()).toEqual(['Alpha', 'Beta', 'Gamma']);
    });

    it.each(['../escape', 'a/../../escape', '/escape', 'a\\b', '..', '.', ''])('refuses to create a folder for a name that reaches outside the mods folder: %j', async (name) => {
      await expect(adapter.createModFolder(name)).rejects.toThrow(`Not a valid mod name: "${name}"`);
      expect(await folderNames()).toEqual(['Alpha', 'Beta', 'Gamma']);
    });

    it('shows a folder it created to the next read', async () => {
      await adapter.createModFolder('Fresh');
      expect(await folderNames()).toEqual(['Alpha', 'Beta', 'Fresh', 'Gamma']);
    });

    it('refuses to rename a folder that is not there', async () => {
      await expect(adapter.renameModFolder('Nope', 'Other')).rejects.toThrow('Mod not found in modlist: Nope');
    });

    it('refuses to rename a folder to the name of one that is there, in any case', async () => {
      await expect(adapter.renameModFolder('Alpha', 'gamma')).rejects.toThrow(/is in the way/);
      expect(await folderNames()).toEqual(['Alpha', 'Beta', 'Gamma']);
    });

    it('shows a folder it renamed to the next read', async () => {
      await adapter.renameModFolder('alpha', 'Omega');
      expect(await folderNames()).toEqual(['Beta', 'Gamma', 'Omega']);
    });

    it('trashes the folder that holds an entry, then holds none', async () => {
      expect(await adapter.trashEntryFolder({ kind: 'mod', name: 'ALPHA' }, trash)).toBe(true);
      expect(await folderNames()).toEqual(['Beta', 'Gamma']);
      expect(await adapter.trashEntryFolder({ kind: 'mod', name: 'Alpha' }, trash)).toBe(false);
    });

  });

  describe('downloaded files', () => {
    it('gives a downloaded file that is gone no mark', async () => {
      expect(await adapter.markDownloadedFile('Gone.7z', 'Excluded')).toEqual({ gone: true });
    });

    it('trashes a downloaded file that is there, then it is gone', async () => {
      expect(await adapter.trashDownloadedFile('Fresh.7z', trash)).toEqual({ gone: false });
      expect(await downloadedNames()).toEqual([]);
      expect(await adapter.trashDownloadedFile('Fresh.7z', trash)).toEqual({ gone: true });
    });

    it('writes a mark once, and shows it to the next read', async () => {
      expect(await adapter.markDownloadedFile('Fresh.7z', 'Excluded')).toEqual({ gone: false, wrote: true });
      expect((await downloadedFile('Fresh.7z'))?.excluded).toBe(true);
      expect(await adapter.markDownloadedFile('Fresh.7z', 'Excluded')).toEqual({ gone: false, wrote: false });
      expect(await adapter.markDownloadedFile('Fresh.7z', 'Included')).toEqual({ gone: false, wrote: true });
      expect((await downloadedFile('Fresh.7z'))?.excluded).toBe(false);
    });
  });

  describe('origin files', () => {
    it('answers the file an origin holds, and none for a file it does not', async () => {
      expect((await adapter.originFile(ALPHA, 'textures/a.dds'))?.relativePath).toBe('textures/a.dds');
      expect(await adapter.originFile(ALPHA, 'textures/none.dds')).toBeUndefined();
      expect(await adapter.originFile(BETA, 'textures/a.dds')).toBeUndefined();
    });

    it('gives an origin file that is gone no mark', async () => {
      expect(await adapter.markOriginFile(ALPHA, 'textures/none.dds', 'Excluded')).toEqual({ gone: true });
    });

    it('marks an origin file that is there with the mark it names', async () => {
      const marked = `textures/a.dds${adapter.exclusionMark}`;
      expect(await adapter.markOriginFile(ALPHA, 'textures/a.dds', 'Excluded')).toEqual({ gone: false, wrote: true, relativePath: marked });
      expect(await filesOf(ALPHA)).toEqual(['Other.esp', 'Patch.esp', marked]);
      expect((await adapter.originFile(ALPHA, marked))?.excluded).toBe(true);
      expect(await adapter.markOriginFile(ALPHA, marked, 'Excluded')).toEqual({ gone: false, wrote: false, relativePath: marked });
      expect(await adapter.markOriginFile(ALPHA, marked, 'Included')).toEqual({ gone: false, wrote: true, relativePath: 'textures/a.dds' });
      expect(await filesOf(ALPHA)).toEqual(['Other.esp', 'Patch.esp', 'textures/a.dds']);
    });

    it('refuses to include a file whose folder excludes it, which has no suffix of its own', async () => {
      const path = `meshes${adapter.exclusionMark}/b.nif`;
      expect(await adapter.markOriginFile(GAMMA, path, 'Included'))
        .toEqual({ gone: false, refusal: `"${path}" has no suffix of its own to remove, and its folder excludes it.` });
    });

    it('refuses to mark a file onto a name that is there', async () => {
      const marked = `x.dds${adapter.exclusionMark}`;
      expect(await adapter.markOriginFile(GAMMA, 'x.dds', 'Excluded')).toEqual({ gone: false, refusal: `"${marked}" is already there.` });
      expect(await adapter.markOriginFile(GAMMA, marked, 'Included')).toEqual({ gone: false, refusal: '"x.dds" is already there.' });
    });

    it.each(['../Beta/Taken.esp', 'textures//a.dds', 'textures/../../Beta/Taken.esp', 'textures\\..\\a.dds', 'a/../../outside.txt', '/etc/hosts', ''])('refuses a path that reaches outside the origin: %s', async (path) => {
      const notAFile = `Not a file of mod "Alpha": "${path}"`;
      await expect(adapter.originFile(ALPHA, path)).rejects.toThrow(notAFile);
      await expect(adapter.markOriginFile(ALPHA, path, 'Excluded')).rejects.toThrow(notAFile);
      await expect(adapter.trashModFile('Alpha', path, trash)).rejects.toThrow(notAFile);
    });
  });

  describe('plugins', () => {
    it('holds a plugin its origin holds at its root, named in any case', async () => {
      expect(await adapter.originHoldsPlugin(ALPHA, 'patch.ESP')).toBe(true);
      expect(await adapter.originHoldsPlugin(BETA, 'Patch.esp')).toBe(false);
      expect(await adapter.originHoldsPlugin(ALPHA, 'a.dds')).toBe(false);
    });

    it('refuses to rename a plugin its origin does not hold', async () => {
      await expect(adapter.renamePlugin(ALPHA, 'Ghost.esp', 'Real.esp')).rejects.toThrow('Not a file of mod "Alpha": "Ghost.esp"');
    });

    it('refuses to rename a plugin to a name its origin holds', async () => {
      await expect(adapter.renamePlugin(ALPHA, 'Patch.esp', 'other.ESP')).rejects.toThrow(/is in the way/);
      expect(await filesOf(ALPHA)).toEqual(['Other.esp', 'Patch.esp', 'textures/a.dds']);
    });

    it('refuses to rename a plugin to a name the plugin order lists, and changes nothing', async () => {
      await expect(adapter.renamePlugin(ALPHA, 'Patch.esp', 'taken.esp')).rejects.toThrow('Plugin already in plugins.txt: Taken.esp');
      expect(await pluginOrderOf(adapter)).toEqual(['Patch.esp', 'Taken.esp']);
      expect(await filesOf(ALPHA)).toEqual(['Other.esp', 'Patch.esp', 'textures/a.dds']);
    });

    it('shows a plugin it renamed to the next read, in its origin and the plugin order', async () => {
      await adapter.renamePlugin(ALPHA, 'patch.esp', 'Renamed.esp');
      expect(await adapter.originHoldsPlugin(ALPHA, 'Renamed.esp')).toBe(true);
      expect(await adapter.originHoldsPlugin(ALPHA, 'Patch.esp')).toBe(false);
      expect(await pluginOrderOf(adapter)).toEqual(['Renamed.esp', 'Taken.esp']);
    });
  });
});
