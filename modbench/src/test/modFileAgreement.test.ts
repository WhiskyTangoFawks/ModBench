import { describe, it, expect, vi } from 'vitest';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri,
} from './vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri,
}));

import { FILE_CONFLICTS } from '../agent/fileConflicts';
import type { PublisherConfiguration, PublisherTag } from '../instanceAdapter/instanceAdapter';
import { modOrigin } from '../instanceLoader/fileConflictIndex';
import { MOD_INDICATORS } from '../drivingLib/modFileStates';
import { FakeInstance } from './mo2/fakeInstance';
import { fakeInstanceAdapter, readingFixture } from './fakeInstanceAdapter';
import { copiesToRead } from '../drivingLib/copiesToRead';
import { sameCopies } from '../drivingLib/sameCopies';
import { conflictPaths, conflictTable } from '../mods/conflictTable';
import { InactiveFileDecorationProvider } from '../mods/inactiveFiles';
import { fileRowUri } from '../mods/modFiles';
import { indicatorSetting, ModIndicatorDecorations, modRowUri } from '../mods/modIndicators';
import { OpenRows } from '../mods/openRows';
import { PublisherTagDecorations } from '../mods/publisherTagIndicators';
import { file, indexedValueOf, mod } from '../mods/test/indexedValue';

const NM: PublisherTag = { name: 'NM tag', badge: 'NM', marksPaths: true };
const AE: PublisherTag = { name: 'AE tag', badge: 'AE', marksPaths: false };
const COVERED: Record<string, readonly PublisherTag[]> = {
  '/instance/Winner/a.dds': [NM, AE],
  '/instance/Winner/own.esp': [AE],
  '/instance/Loser/a.dds': [NM],
};
const publisherConfiguration: PublisherConfiguration = { kind: 'read', covering: (path) => COVERED[path] ?? [], listed: () => [], pathProblems: [], unshippable: { file: '', reason: () => undefined } };

const switchesOn = Object.fromEntries([...MOD_INDICATORS.map(({ id }) => id), 'publisherTag' as const]
  .flatMap((id) => [[indicatorSetting(id, 'badge'), true], [indicatorSetting(id, 'colour'), true]]));
const settings = {
  getConfiguration: () => ({ get: (key: string) => switchesOn[key] }),
  onDidChangeConfiguration: new EventEmitter<{ affectsConfiguration: (key: string) => boolean }>().event,
};

interface Contents { state: string | null; row: string | null; size?: number; modified?: number; unreadable?: string }

interface AgentMod { mod: string; indicators: string[]; files: { file: string; gotten: boolean; publisherTags: string[]; contents?: Contents }[] }

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
    const read = await FILE_CONFLICTS.of(value, fakeInstanceAdapter().adapter, { mods: shown.map(({ mod: name }) => ({ name })) }) as AgentMod[];

    expect(read.map(({ mod: name, indicators: held, files }) => ({
      mod: name, indicators: held, files: files.map(({ file: path, gotten, publisherTags }) => ({ file: path, gotten, publisherTags })),
    }))).toEqual(shown);
    expect(shown.flatMap(({ indicators: held }) => held)).not.toEqual([]);
    expect(shown.flatMap(({ files }) => files).map(({ publisherTags }) => publisherTags)).toContainEqual(['NM tag']);
    expect(shown.flatMap(({ files }) => files).map(({ gotten }) => gotten)).toContain(false);
  });
});

const NS = 1_577_836_800_000_000_000n;
const stamp = (size: number, days: number) => ({ size: BigInt(size), modifiedNs: NS + BigInt(days) * 86_400_000_000_000n, changedNs: NS });
const at = (mod: string, path: string) => `/instance/${mod}/${path}`;
const NAMES = ['High', 'Middle', 'Low'];

describe('what the conflict table shows of a file\'s contents, and what the agent reads (agent.md, Any agent, story 8)', () => {
  it('agrees on the state of each mod\'s copy and of the row, with the copy\'s size and date, or why it cannot be read', async () => {
    const hashes: Record<string, string[]> = {
      'same.dds': ['a', 'a', 'a'], 'override.dds': ['b', 'b', 'a'], 'conflict.dds': ['c', 'b', 'a'], 'lost.dds': ['a', 'b', 'a'],
    };
    const paths = Object.keys(hashes);
    const value = await indexedValueOf(NAMES.map((name) => mod(name)), Object.fromEntries(
      NAMES.map((name) => [name, { files: paths.map((path) => file(name, path)) }]),
    ));
    const adapter = fakeInstanceAdapter(readingFixture(), {
      stamps: new Map(paths.flatMap((path) => NAMES.flatMap((name, order) =>
        (name === 'Middle' && path === 'lost.dds' ? [] : [[at(name, path), stamp(8, order + paths.indexOf(path))] as const])))),
      hashes: new Map(paths.flatMap((path) => NAMES.map((name, order) => [at(name, path), { size: 8, hash: hashes[path]?.[order] ?? '' }] as const))),
    }).adapter;

    const shown = await Promise.all(NAMES.map(async (name) => {
      const view = { value, sequence: 1 };
      const table = conflictTable(view, name, await sameCopies(adapter, copiesToRead(value, conflictPaths(view, name))), 'size');
      const column = table.kind === 'table' ? table.columns.findIndex(({ origin }) => origin.kind === 'mod' && origin.name === name) : -1;
      return {
        mod: name,
        contents: table.kind === 'table' ? table.rows.flatMap((row): [string, Contents][] => {
          const cell = row.kind === 'file' ? row.cells[column] : undefined;
          return row.kind === 'file' && cell ? [[row.path, {
            state: cell.state, row: row.state, size: cell.size, modified: cell.modified, unreadable: cell.unreadable,
          }]] : [];
        }) : [],
      };
    }));
    const read = await FILE_CONFLICTS.of(value, adapter, { mods: NAMES.map((name) => ({ name })) }) as AgentMod[];

    const plain = (entries: [string, Contents][]) => entries.map(([path, held]) => [path, held] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    expect(read.map(({ mod: name, files }) => ({
      mod: name, contents: plain(files.flatMap(({ file: path, contents: held }) => (held ? [[path, held] as [string, Contents]] : []))),
    }))).toEqual(shown.map(({ mod: name, contents: held }) => ({ mod: name, contents: plain(held) })));
    const states = shown.flatMap(({ contents: held }) => held.map(([, one]) => one.state));
    expect(states).toEqual(expect.arrayContaining(['Master', 'IdenticalToMaster', 'Override', 'ConflictWins', 'ConflictLoses', null]));
  });
});
