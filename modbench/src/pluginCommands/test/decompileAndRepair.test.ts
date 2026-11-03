import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter, readingFixture, repositoriesOf } from '../../test/fakeInstanceAdapter';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { isRefused, type MEditClient, type PluginAddress, type SourceModIn } from '../../client';
import type { PlaceMods } from '../decompileAndRepair';

const MALFORMED = { name: 'Malformed.esp', origin: 'Harbor' };
const OTHER = { name: 'Other.esp', origin: 'Quay' };
const REFUSED = { item: { name: 'Clean.esp', origin: 'Harbor' }, reason: 'Clean.esp is not malformed.' };
const MADE = { modFolder: '/mods/Harbor', sourceFolder: { path: '/source/Harbor', in: 'NewRepository' as const, assets: ['a.dds'], buildFile: '{}' } };

interface Placing {
  notMade: Record<string, string>;
  notLinked: Record<string, string>;
  notTakenBack: Record<string, string>;
  whole: string | undefined;
  notes: string[];
}

describe('decompileAndRepair', () => {
  let client: InMemoryMEditClient;
  let placing: Placing;
  let requests: { readonly mods: readonly string[]; readonly where: SourceModIn }[];

  const placeMods: PlaceMods = async (request, run, landedBy) => {
    requests.push(request);
    const made = new Map(request.mods.filter((mod) => !(mod in placing.notMade)).map((mod) => [mod, { ...MADE, sourceFolder: { ...MADE.sourceFolder, in: request.where } }]));
    if (placing.whole !== undefined) return { refused: true, message: placing.whole };
    const outcome = await run(made);
    const landed = new Set(isRefused(outcome) ? [] : landedBy(outcome));
    const left = new Map(Object.entries(placing.notTakenBack));
    return {
      outcome, notMade: new Map(Object.entries(placing.notMade)), notTakenBack: left, notes: placing.notes,
      notLinked: new Map(Object.entries(placing.notLinked).filter(([mod]) => landed.has(mod))),
      withLinesLeft: (refused, modOf) => refused.map((entry) => ({ ...entry, reason: [entry.reason, left.get(modOf(entry.item))].filter(Boolean).join(' ') })),
    };
  };
  const commandsOver = (sourceMods: Record<string, string>) =>
    pluginCommandsWith(fakeInstanceAdapter(readingFixture({ sourceModFolders: repositoriesOf(sourceMods) })).adapter, client, placeMods);
  const repairIn = (sourceMods: Record<string, string>, force = false, plugins: readonly PluginAddress[] = [MALFORMED], where: SourceModIn = 'NewRepository') =>
    commandsOver(sourceMods).decompileAndRepair(plugins, force, where);
  const sent = () => client.calls.filter((call) => call.method === 'decompileAndRepair').map((call) => call.args);
  const landingEach: MEditClient['decompileAndRepair'] = (plugins) => Promise.resolve({
    landed: plugins.map(({ plugin }) => plugin),
    refused: [REFUSED],
  });

  beforeEach(() => {
    client = new InMemoryMEditClient();
    client.setCommandHandler('decompileAndRepair', landingEach);
    placing = { notMade: {}, notLinked: {}, notTakenBack: {}, whole: undefined, notes: [] };
    requests = [];
  });

  it('repairs each plugin, a mod that is not a source mod handed the source folder made for it', async () => {
    expect(await repairIn({}, true)).toEqual({ applied: true, outcome: { landed: [MALFORMED], refused: [REFUSED] } });
    expect(sent()).toEqual([[[{ plugin: MALFORMED, sourceFolder: MADE.sourceFolder }], true]]);
  });

  it('places the mods that are not source mods once each, in the repository it is given (source.md, Decompile and repair, story 4)', async () => {
    await repairIn({}, true, [MALFORMED, OTHER, { name: 'Second.esp', origin: 'Harbor' }], 'InstanceRepository');

    expect(requests).toEqual([{ mods: ['Harbor', 'Quay'], where: 'InstanceRepository' }]);
  });

  it('places no mod when every plugin is in a source mod, and hands the plugin alone', async () => {
    await repairIn({ Harbor: '/source/Harbor' }, false);

    expect([requests, sent()]).toEqual([[{ mods: [], where: 'NewRepository' }], [[[{ plugin: MALFORMED }], false]]]);
  });

  it('answers what a downloaded file could not give, for the user to be told', async () => {
    placing.notes = ['Pack.7z could not be read whole.'];

    expect(await repairIn({}, true)).toMatchObject({ applied: true, notes: ['Pack.7z could not be read whole.'] });
  });

  it('answers no notes when no downloaded file had any', async () => {
    expect(await repairIn({}, true)).not.toHaveProperty('notes');
  });

  it('names a repaired mod whose folder could not be linked, as the repair that happened', async () => {
    placing.notLinked = { Harbor: 'its manifest could not name its repository: EACCES' };

    expect(await repairIn({}, true)).toEqual({ applied: true, outcome: {
      landed: [MALFORMED], refused: [REFUSED, { item: MALFORMED, reason: 'was repaired, but its manifest could not name its repository: EACCES.' }],
    } });
  });

  it('refuses a plugin whose mod no source folder can be made for, naming why, and repairs nothing for it', async () => {
    placing.notMade = { Harbor: 'its metadata could not be read: EACCES' };

    expect(await repairIn({}, true)).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: MALFORMED, reason: 'Harbor is not a source mod, and a source folder cannot be made for it: its metadata could not be read: EACCES' }] } });
    expect(sent()).toEqual([]);
  });

  it('refuses the whole gesture, repairing nothing, when placing the mods does', async () => {
    placing.whole = 'The instance holds no repository to put a mod in: git init makes one.';

    expect(await repairIn({}, true)).toEqual({ applied: false, refusal: placing.whole });
    expect(sent()).toEqual([]);
  });

  it('adds what stays in the ignore list to the reason of the plugins of the mod it concerns only', async () => {
    placing.notTakenBack = { Quay: 'The ignore list still lets in /source/Quay.' };
    client.setCommandHandler('decompileAndRepair', (plugins) => Promise.resolve({
      landed: [], refused: plugins.map(({ plugin }) => ({ item: plugin, reason: 'refused.' })),
    }));

    expect(await repairIn({}, true, [MALFORMED, OTHER])).toEqual({ applied: true, outcome: { landed: [], refused: [
      { item: MALFORMED, reason: 'refused.' }, { item: OTHER, reason: 'refused. The ignore list still lets in /source/Quay.' },
    ] } });
  });

  it('says what stays in the ignore list when mEdit refuses the whole repair', async () => {
    placing.notTakenBack = { Harbor: 'The ignore list still lets in /source/Harbor.' };
    client.setCommandHandler('decompileAndRepair', () => Promise.resolve({ refused: true, message: 'mEdit is busy.' }));

    expect(await repairIn({}, true)).toEqual({ applied: false, refusal: 'mEdit is busy. The ignore list still lets in /source/Harbor.' });
  });
});
