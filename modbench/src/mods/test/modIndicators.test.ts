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
import type { InstanceValue } from '../../instanceLoader/instance';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { accessTo } from '../../test/mo2/adapterOver';
import { present } from '../../ports/present';
import { ModListProvider, ModNode } from '../ModListProvider';
import { indicatorSetting, ModIndicatorDecorations, modIndicators, type ModIndicator } from '../modIndicators';
import { file, indexedValueOf, mod } from './indexedValue';

const carriedBy = (value: InstanceValue, name: string) => modIndicators(value).get(name) ?? [];

describe('the indicators each mod carries (mods.md, Indicators)', () => {
  it('a mod whose file wins over another copy overwrites loose files, and one whose file loses to it is overwritten', async () => {
    const value = await indexedValueOf([mod('Winner'), mod('Loser')], {
      Winner: { files: [file('Winner', 'a.dds')] }, Loser: { files: [file('Loser', 'a.dds'), file('Loser', 'own.dds')] },
    });

    expect(carriedBy(value, 'Winner')).toEqual(['overwritesLooseFiles']);
    expect(carriedBy(value, 'Loser')).toEqual(['overwrittenLooseFiles']);
  });

  it('a mod every file of which loses is redundant, and not overwritten', async () => {
    const value = await indexedValueOf([mod('Winner'), mod('Loser')], {
      Winner: { files: [file('Winner', 'a.dds'), file('Winner', 'b.dds')] },
      Loser: { files: [file('Loser', 'a.dds'), file('Loser', 'b.dds')] },
    });

    expect(carriedBy(value, 'Loser')).toEqual(['redundant']);
  });

  it('a mod between two copies of a file wins over one and loses to the other, so carries both', async () => {
    const value = await indexedValueOf([mod('High'), mod('Middle'), mod('Low')], {
      High: { files: [file('High', 'a.dds')] },
      Middle: { files: [file('Middle', 'a.dds'), file('Middle', 'own.dds')] },
      Low: { files: [file('Low', 'a.dds')] },
    });

    expect(carriedBy(value, 'Middle')).toEqual(['overwritesLooseFiles', 'overwrittenLooseFiles']);
  });

  it('a mod whose file loses to Overwrite\'s is overwritten', async () => {
    const value = await indexedValueOf([mod('A')], { A: { files: [file('A', 'a.log'), file('A', 'own.dds')] } }, {
      files: [file('overwrite', 'a.log')],
    });

    expect(carriedBy(value, 'A')).toEqual(['overwrittenLooseFiles']);
  });

  it('a mod with an excluded file contains excluded files, and its excluded copy neither wins nor loses', async () => {
    const value = await indexedValueOf([mod('Winner'), mod('Loser')], {
      Winner: { files: [file('Winner', 'a.dds', true), file('Winner', 'own.dds')] }, Loser: { files: [file('Loser', 'a.dds')] },
    });

    expect(carriedBy(value, 'Winner')).toEqual(['containsExcludedFiles']);
    expect(carriedBy(value, 'Loser')).toEqual([]);
  });

  it('a mod whose every file is excluded has no file the game could get, so is not redundant', async () => {
    const value = await indexedValueOf([mod('A')], { A: { files: [file('A', 'a.dds', true)] } });

    expect(carriedBy(value, 'A')).toEqual(['containsExcludedFiles']);
  });

  it('a disabled mod carries none, nor does a mod with no files', async () => {
    const value = await indexedValueOf([mod('Winner'), mod('Off', false), mod('Empty')], {
      Winner: { files: [file('Winner', 'a.dds')] },
      Off: { files: [file('Off', 'a.dds'), file('Off', 'b.dds', true)] },
    });

    expect([carriedBy(value, 'Off'), carriedBy(value, 'Empty')]).toEqual([[], []]);
  });
});

const settingsOf = (on: Partial<Record<string, boolean>>) => {
  const changed = new EventEmitter<{ affectsConfiguration: (key: string) => boolean }>();
  return {
    changed,
    settings: { getConfiguration: () => ({ get: (key: string) => on[key] }), onDidChangeConfiguration: changed.event },
  };
};

const allOn = Object.fromEntries((['overwritesLooseFiles', 'overwrittenLooseFiles', 'redundant', 'containsExcludedFiles'] as const)
  .flatMap((id) => [[indicatorSetting(id, 'badge'), true], [indicatorSetting(id, 'colour'), true]]));

async function rowUriOf(instance: FakeInstance, name: string): Promise<vscode.Uri> {
  const rows = new ModListProvider({ instance, access: accessTo('/instance'), log: () => undefined });
  const row = (await rows.getChildren()).find((node) => node instanceof ModNode && node.mod.name === name);
  return present(row?.resourceUri, `${name}'s row URI`);
}

const decorationsOn = (decorations: ModIndicatorDecorations, uri: vscode.Uri) =>
  decorations.providers.map((provider) => provider.provideFileDecoration(uri));

const middleOfThree = () => indexedValueOf([mod('High'), mod('Middle'), mod('Low')], {
  High: { files: [file('High', 'a.dds')] },
  Middle: { files: [file('Middle', 'a.dds'), file('Middle', 'own.dds'), file('Middle', 'b.dds', true)] },
  Low: { files: [file('Low', 'a.dds')] },
});

describe('a mod row\'s indicators, each switched in settings (mods.md, A row, Mod; Indicators)', () => {
  it('carries a badge and a colour for each indicator that holds, its tooltip the indicator\'s name', async () => {
    const instance = new FakeInstance(await middleOfThree());
    const decorations = new ModIndicatorDecorations(instance, settingsOf(allOn).settings);

    expect(decorationsOn(decorations, await rowUriOf(instance, 'Middle'))).toEqual([
      { badge: '\u2295', color: new ThemeColor('modbench.modOverwritesLooseFiles'), tooltip: 'Overwrites loose files' },
      { badge: '\u2296', color: new ThemeColor('modbench.modOverwrittenLooseFiles'), tooltip: 'Overwritten loose files' },
      undefined,
      { badge: '\u2298', color: new ThemeColor('modbench.modContainsExcludedFiles'), tooltip: 'Contains excluded files' },
    ]);
  });

  it('carries only the parts its settings switch on, and nothing for an indicator with both off', async () => {
    const instance = new FakeInstance(await middleOfThree());
    const decorations = new ModIndicatorDecorations(instance, settingsOf({
      [indicatorSetting('overwritesLooseFiles', 'badge')]: true,
      [indicatorSetting('overwrittenLooseFiles', 'colour')]: true,
    }).settings);

    expect(decorationsOn(decorations, await rowUriOf(instance, 'Middle'))).toEqual([
      { badge: '\u2295', color: undefined, tooltip: 'Overwrites loose files' },
      { badge: undefined, color: new ThemeColor('modbench.modOverwrittenLooseFiles'), tooltip: 'Overwritten loose files' },
      undefined,
      undefined,
    ]);
  });

  it('decorates no mod\'s folder where the Explorer shows it', async () => {
    const decorations = new ModIndicatorDecorations(new FakeInstance(await middleOfThree()), settingsOf(allOn).settings);

    expect(decorationsOn(decorations, vscode.Uri.file('/instance/Middle'))).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('asks VS Code to decorate again on each new instance value, and answers from that value', async () => {
    const instance = new FakeInstance(await middleOfThree());
    const decorations = new ModIndicatorDecorations(instance, settingsOf(allOn).settings);
    const uri = await rowUriOf(instance, 'Low');
    const fired = decorations.providers.map((provider) => {
      const listener = vi.fn();
      provider.onDidChangeFileDecorations(listener);
      return listener;
    });
    expect(decorationsOn(decorations, uri)[2]).toBeDefined();

    instance.publish(await indexedValueOf([mod('Low')], { Low: { files: [file('Low', 'a.dds')] } }));

    expect(fired.map((listener) => listener.mock.calls)).toEqual([[[undefined]], [[undefined]], [[undefined]], [[undefined]]]);
    expect(decorationsOn(decorations, uri)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('asks VS Code to decorate again only for the indicator whose setting changed', async () => {
    const { settings, changed } = settingsOf(allOn);
    const decorations = new ModIndicatorDecorations(new FakeInstance(await middleOfThree()), settings);
    const fired = decorations.providers.map((provider) => {
      const listener = vi.fn();
      provider.onDidChangeFileDecorations(listener);
      return listener;
    });
    const changing = (id: ModIndicator) => (key: string) => key === indicatorSetting(id, 'colour');

    changed.fire({ affectsConfiguration: (key) => key === 'modbench.scriptsPath' });
    changed.fire({ affectsConfiguration: changing('redundant') });

    expect(fired.map((listener) => listener.mock.calls.length)).toEqual([0, 0, 1, 0]);
  });
});
