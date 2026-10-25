import { describe, it, expect, vi } from 'vitest';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri,
} from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri,
}));

import * as vscode from 'vscode';
import type { FileOrigin, InstanceValue } from '../../instanceLoader/instance';
import { modOrigin, RUNTIME_OUTPUT } from '../../instanceLoader/fileConflictIndex';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { present } from '../../ports/present';
import { ModListProvider, ModNode, type ModlistNode } from '../ModListProvider';
import { NO_MOD_STATUSES } from '../../test/noModStatuses';
import { fileRowUri } from '../modFiles';
import { GREY_INACTIVE_FILES_SETTING, InactiveFileDecorationProvider } from '../inactiveFiles';
import { file, folder, indexedValueOf, mod } from './indexedValue';

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

const greyOf = (value: InstanceValue, origin: FileOrigin, relativePath: string) =>
  decorationsOver(new FakeInstance(value)).provideFileDecoration(fileRowUri(origin, relativePath));

const winnerAndLoser = () => indexedValueOf([mod('Winner'), mod('Loser')], {
  Winner: { files: [file('Winner', 'x/a.dds')], folders: [folder('Winner', 'x')] },
  Loser: { files: [file('Loser', 'x/a.dds')], folders: [folder('Loser', 'x')] },
});

describe('each file of a mod or Overwrite, active or inactive (mods.md, The tree, story 8)', () => {
  it.each<[string, () => Promise<InstanceValue>, FileOrigin, string, typeof GREY | undefined]>([
    ['a file another copy wins is inactive', winnerAndLoser, modOrigin('Loser'), 'x/a.dds', GREY],
    ['the copy that wins is active', winnerAndLoser, modOrigin('Winner'), 'x/a.dds', undefined],
    ['a folder whose every file loses is still active: the game merges folders', winnerAndLoser, modOrigin('Loser'), 'x', undefined],
    ['an excluded file is inactive', () => indexedValueOf([mod('A')], { A: { files: [file('A', 'a.dds', true)] } }), modOrigin('A'), 'a.dds', GREY],
    ['a disabled mod\'s file is inactive', () => indexedValueOf([mod('Off', false)], { Off: { files: [file('Off', 'x/a.dds')], folders: [folder('Off', 'x')] } }), modOrigin('Off'), 'x/a.dds', GREY],
    ['a disabled mod\'s folder is inactive', () => indexedValueOf([mod('Off', false)], { Off: { files: [file('Off', 'x/a.dds')], folders: [folder('Off', 'x')] } }), modOrigin('Off'), 'x', GREY],
    ['an excluded folder is inactive', () => indexedValueOf([mod('A')], { A: { files: [], folders: [folder('A', 'x', true)] } }), modOrigin('A'), 'x', GREY],
    ['an excluded file in Overwrite is inactive', () => indexedValueOf([], {}, { files: [file('overwrite', 'b.log', true)] }), RUNTIME_OUTPUT, 'b.log', GREY],
  ])('%s', async (_case, value, origin, path, grey) => {
    expect(greyOf(await value(), origin, path)).toEqual(grey);
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
    const rows = new ModListProvider({ statuses: NO_MOD_STATUSES, instance });
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

    configuration.onDidChangeConfiguration.fire({ affectsConfiguration: (key) => key === 'modbench.something' });
    expect(fired).not.toHaveBeenCalled();
    configuration.onDidChangeConfiguration.fire({ affectsConfiguration: (key) => key === GREY_INACTIVE_FILES_SETTING });
    expect(fired).toHaveBeenCalledWith(undefined);
  });
});
