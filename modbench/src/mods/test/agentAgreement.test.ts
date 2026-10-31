import { describe, it, expect, vi } from 'vitest';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri,
} from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri,
}));

import { FILE_CONFLICTS } from '../../agent/fileConflicts';
import type { PublisherConfiguration, PublisherTag } from '../../instanceAdapter/instanceAdapter';
import { modOrigin } from '../../instanceLoader/fileConflictIndex';
import { MOD_INDICATORS } from '../../drivingLib/modFileStates';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { InactiveFileDecorationProvider } from '../inactiveFiles';
import { fileRowUri } from '../modFiles';
import { indicatorSetting, ModIndicatorDecorations, modRowUri } from '../modIndicators';
import { OpenRows } from '../openRows';
import { PublisherTagDecorations } from '../publisherTagIndicators';
import { file, indexedValueOf, mod } from './indexedValue';

const NM: PublisherTag = { name: 'NM tag', badge: 'NM', marksPaths: true };
const AE: PublisherTag = { name: 'AE tag', badge: 'AE', marksPaths: false };
const COVERED: Record<string, readonly PublisherTag[]> = {
  '/instance/Winner/a.dds': [NM, AE],
  '/instance/Winner/own.esp': [AE],
  '/instance/Loser/a.dds': [NM],
};
const publisherConfiguration: PublisherConfiguration = { kind: 'read', covering: (path) => COVERED[path] ?? [], listed: () => [], pathProblems: [] };

const switchesOn = Object.fromEntries([...MOD_INDICATORS.map(({ id }) => id), 'publisherTag' as const]
  .flatMap((id) => [[indicatorSetting(id, 'badge'), true], [indicatorSetting(id, 'colour'), true]]));
const settings = {
  getConfiguration: () => ({ get: (key: string) => switchesOn[key] }),
  onDidChangeConfiguration: new EventEmitter<{ affectsConfiguration: (key: string) => boolean }>().event,
};

interface AgentMod { mod: string; indicators: string[]; files: { file: string; gotten: boolean; publisherTags: string[] }[] }

describe('what the Mods view shows of a mod\'s files, and what the agent reads (agent.md, Any agent, story 8)', () => {
  it('agrees on the row\'s indicators, the grey on each file and the publisher tags that mark it', async () => {
    const value = {
      ...await indexedValueOf([mod('Winner'), mod('Loser'), mod('Off', false), { ...mod('Stale'), updateAvailable: true }], {
        Winner: { files: [file('Winner', 'a.dds'), file('Winner', 'own.esp'), file('Winner', 'b.dds', true)] },
        Loser: { files: [file('Loser', 'a.dds')] },
        Off: { files: [file('Off', 'a.dds')] },
        Stale: { files: [] },
      }),
      publisherConfiguration, publisherTags: [NM, AE],
    };
    const instance = new FakeInstance(value);
    const indicators = new ModIndicatorDecorations(instance, new OpenRows(instance), settings);
    const grey = new InactiveFileDecorationProvider(instance, settings);
    const tags = new PublisherTagDecorations(instance, new OpenRows(instance), settings);

    const shown = ['Winner', 'Loser', 'Off', 'Stale'].map((name) => ({
      mod: name,
      indicators: MOD_INDICATORS.flatMap(({ id }, at) => (indicators.providers[at]?.provideFileDecoration(modRowUri(name)) === undefined ? [] : [id])),
      files: (value.filesByMod.get(name) ?? []).map((one) => {
        const row = fileRowUri(modOrigin(name), one.relativePath);
        return {
          file: one.relativePath, gotten: grey.provideFileDecoration(row) === undefined,
          publisherTags: tags.providers.flatMap((provider) => provider.provideFileDecoration(row)?.tooltip ?? []),
        };
      }).sort((a, b) => (a.file < b.file ? -1 : 1)),
    }));
    const read = FILE_CONFLICTS.of(value, { mods: shown.map(({ mod: name }) => ({ name })) }) as AgentMod[];

    expect(read.map(({ mod: name, indicators: held, files }) => ({
      mod: name, indicators: held, files: files.map(({ file: path, gotten, publisherTags }) => ({ file: path, gotten, publisherTags })),
    }))).toEqual(shown);
    expect(shown.flatMap(({ indicators: held }) => held)).not.toEqual([]);
    expect(shown.flatMap(({ files }) => files).map(({ publisherTags }) => publisherTags)).toContainEqual(['NM tag']);
    expect(shown.flatMap(({ files }) => files).map(({ gotten }) => gotten)).toContain(false);
  });
});
