import { describe, it, expect, vi } from 'vitest';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, uriFile, uriFrom,
} from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: {
    file: uriFile,
    from: (parts: { scheme: string; path: string }) => ({ ...uriFrom(parts), toString: () => `${parts.scheme}:${parts.path}` }),
  },
}));

import * as vscode from 'vscode';
import type { FileOrigin, InstanceValue } from '../../instanceLoader/instance';
import { modOrigin, RUNTIME_OUTPUT } from '../../instanceLoader/fileConflictIndex';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { accessTo } from '../../test/mo2/adapterOver';
import { present } from '../../ports/present';
import { ModListProvider, ModNode, type ModlistNode } from '../ModListProvider';
import { fileRowUri } from '../modFiles';
import { GREY_INACTIVE_FILES_SETTING, InactiveFileDecorationProvider, inactiveFiles } from '../inactiveFiles';
import { file, folder, indexedValueOf, mod } from './indexedValue';

const whyOf = (value: InstanceValue, origin: FileOrigin, relativePath: string) =>
  inactiveFiles(value).get(fileRowUri(origin, relativePath).toString());

const settingOn = (on: boolean | undefined) => ({
  getConfiguration: () => ({ get: () => on }),
  onDidChangeConfiguration: new EventEmitter<{ affectsConfiguration: (key: string) => boolean }>(),
});

function decorationsOver(instance: FakeInstance, configuration = settingOn(undefined)) {
  return new InactiveFileDecorationProvider(instance, {
    getConfiguration: configuration.getConfiguration, onDidChangeConfiguration: configuration.onDidChangeConfiguration.event,
  });
}

const GREY = { color: new ThemeColor('disabledForeground') };

describe('each file of a mod or Overwrite, active or inactive and why (mods.md, The tree, story 8)', () => {
  it('a file another copy wins loses, and the copy that wins is active', async () => {
    const value = await indexedValueOf([mod('Winner'), mod('Loser')], {
      Winner: { files: [file('Winner', 'a.dds')] }, Loser: { files: [file('Loser', 'a.dds')] },
    });

    expect(whyOf(value, modOrigin('Loser'), 'a.dds')).toBe('loses');
    expect(whyOf(value, modOrigin('Winner'), 'a.dds')).toBeUndefined();
  });

  it('an excluded file is inactive, and the copy it would have won over is active', async () => {
    const value = await indexedValueOf([mod('Winner'), mod('Loser')], {
      Winner: { files: [file('Winner', 'a.dds', true)] }, Loser: { files: [file('Loser', 'a.dds')] },
    });

    expect(whyOf(value, modOrigin('Winner'), 'a.dds')).toBe('excluded');
    expect(whyOf(value, modOrigin('Loser'), 'a.dds')).toBeUndefined();
  });

  it('every file and folder of a disabled mod is inactive, and the copy it would have won over is active', async () => {
    const value = await indexedValueOf([mod('Off', false), mod('On')], {
      Off: { files: [file('Off', 'x/a.dds'), file('Off', 'b.esp', true)], folders: [folder('Off', 'x')] },
      On: { files: [file('On', 'x/a.dds')], folders: [folder('On', 'x')] },
    });

    expect(['x/a.dds', 'b.esp', 'x'].map((path) => whyOf(value, modOrigin('Off'), path))).toEqual(['modDisabled', 'modDisabled', 'modDisabled']);
    expect(['x/a.dds', 'x'].map((path) => whyOf(value, modOrigin('On'), path))).toEqual([undefined, undefined]);
  });

  it('an excluded folder is inactive, with everything in it, as the listing marks them', async () => {
    const value = await indexedValueOf([mod('A')], {
      A: { files: [file('A', 'x/a.dds', true)], folders: [folder('A', 'x', true), folder('A', 'y')] },
    });

    expect(['x', 'x/a.dds', 'y'].map((path) => whyOf(value, modOrigin('A'), path))).toEqual(['excluded', 'excluded', undefined]);
  });

  it('a folder whose every file loses is still active: the game merges folders', async () => {
    const value = await indexedValueOf([mod('Winner'), mod('Loser')], {
      Winner: { files: [file('Winner', 'x/a.dds')], folders: [folder('Winner', 'x')] },
      Loser: { files: [file('Loser', 'x/a.dds')], folders: [folder('Loser', 'x')] },
    });

    expect(whyOf(value, modOrigin('Loser'), 'x')).toBeUndefined();
  });

  it('Overwrite\'s file wins over every mod\'s, and an excluded one there is inactive', async () => {
    const value = await indexedValueOf([mod('A')], { A: { files: [file('A', 'a.log')] } }, {
      files: [file('overwrite', 'a.log'), file('overwrite', 'b.log', true)],
    });

    expect(whyOf(value, RUNTIME_OUTPUT, 'a.log')).toBeUndefined();
    expect(whyOf(value, RUNTIME_OUTPUT, 'b.log')).toBe('excluded');
    expect(whyOf(value, modOrigin('A'), 'a.log')).toBe('loses');
  });

  it('two mods holding one path are two files, each with its own answer', async () => {
    const value = await indexedValueOf([mod('A'), mod('B')], { A: { files: [file('A', 'a.dds')] }, B: { files: [file('B', 'a.dds')] } });

    expect(fileRowUri(modOrigin('A'), 'a.dds').toString()).not.toBe(fileRowUri(modOrigin('B'), 'a.dds').toString());
    expect([whyOf(value, modOrigin('A'), 'a.dds'), whyOf(value, modOrigin('B'), 'a.dds')]).toEqual([undefined, 'loses']);
  });
});

describe('the grey on a file the game does not get, in the Mods tree and the Explorer (mods.md, The tree, stories 8 and 10)', () => {
  async function losingRowOf(provider: ModListProvider): Promise<ModlistNode> {
    const loser = (await provider.getChildren()).find((row) => row instanceof ModNode && row.mod.name === 'Loser');
    return present((await provider.getChildren(loser))[0], 'the losing file\'s row');
  }

  it('greys the row of a file the game does not get, and the file itself where the Explorer shows it', async () => {
    const instance = new FakeInstance(await indexedValueOf([mod('Winner'), mod('Loser')], {
      Winner: { files: [file('Winner', 'a.dds')] }, Loser: { files: [file('Loser', 'a.dds')] },
    }));
    const rows = new ModListProvider({ instance, access: accessTo('/instance'), log: () => undefined });
    const decorations = decorationsOver(instance);

    expect(decorations.provideFileDecoration(present((await losingRowOf(rows)).resourceUri, 'its row\'s URI'))).toEqual(GREY);
    expect(decorations.provideFileDecoration(vscode.Uri.file('/instance/Loser/a.dds'))).toEqual(GREY);
    expect(decorations.provideFileDecoration(vscode.Uri.file('/instance/Winner/a.dds'))).toBeUndefined();
  });

  it('greys an excluded folder where the Explorer shows it', async () => {
    const instance = new FakeInstance(await indexedValueOf([mod('A')], { A: { files: [], folders: [folder('A', 'x', true)] } }));

    expect(decorationsOver(instance).provideFileDecoration(vscode.Uri.file('/instance/A/x'))).toEqual(GREY);
  });

  it('greys nothing while the setting is off, and greys on by default', async () => {
    const instance = new FakeInstance(await indexedValueOf([mod('Off', false)], { Off: { files: [file('Off', 'a.dds')] } }));
    const uri = vscode.Uri.file('/instance/Off/a.dds');

    expect(decorationsOver(instance, settingOn(false)).provideFileDecoration(uri)).toBeUndefined();
    expect(decorationsOver(instance, settingOn(true)).provideFileDecoration(uri)).toEqual(GREY);
    expect(decorationsOver(instance, settingOn(undefined)).provideFileDecoration(uri)).toEqual(GREY);
  });

  it('asks VS Code to decorate again on each new instance value, and answers from that value', async () => {
    const instance = new FakeInstance(await indexedValueOf([mod('A')], { A: { files: [file('A', 'a.dds')] } }));
    const decorations = decorationsOver(instance);
    const fired = vi.fn();
    decorations.onDidChangeFileDecorations(fired);
    const uri = vscode.Uri.file('/instance/A/a.dds');
    expect(decorations.provideFileDecoration(uri)).toBeUndefined();

    instance.publish(await indexedValueOf([mod('A', false)], { A: { files: [file('A', 'a.dds')] } }));

    expect(fired).toHaveBeenCalledWith(undefined);
    expect(decorations.provideFileDecoration(uri)).toEqual(GREY);
  });

  it('asks VS Code to decorate again when its setting changes, and only then', async () => {
    const configuration = settingOn(true);
    const decorations = decorationsOver(new FakeInstance(await indexedValueOf([], {})), configuration);
    const fired = vi.fn();
    decorations.onDidChangeFileDecorations(fired);

    configuration.onDidChangeConfiguration.fire({ affectsConfiguration: (key) => key === 'modbench.scriptsPath' });
    expect(fired).not.toHaveBeenCalled();
    configuration.onDidChangeConfiguration.fire({ affectsConfiguration: (key) => key === GREY_INACTIVE_FILES_SETTING });
    expect(fired).toHaveBeenCalledWith(undefined);
  });
});
