import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter, readingFixture, sourceModsOf } from '../../test/fakeInstanceAdapter';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { MEditClient, PluginRepairPreview } from '../../client';
import { previewLines } from '../decompileAndRepair';

const MALFORMED = { name: 'Malformed.esp', origin: 'Harbor' };
const CLEAN = { name: 'Clean.esp', origin: 'Harbor' };
const DROPS = { description: 'drops 25 bytes of parameters', dropsData: true };
const NOT_MALFORMED = { item: CLEAN, reason: 'Clean.esp is not malformed.' };
const MADE = { folder: '/instance/mods/Harbor', repository: { sourceFolder: '/source/Harbor', assets: ['a.dds'], manifestName: 'Harbor.manifest.json', manifest: '{}' } };
const PREVIEW: PluginRepairPreview = {
  plugin: MALFORMED, hash: 'abc',
  diagnoses: [{ diagnosis: { anchor: 'REGN 00000800 (Harbor)', defectClass: 'short', message: 'RDAT is 6 bytes' }, change: { description: 'pads RDAT from 6 to 8 bytes with zeros', dropsData: false } }],
};

describe('decompileAndRepair — the preview, then the repair of each plugin it previewed', () => {
  let client: InMemoryMEditClient;
  let previews: { landed: PluginRepairPreview[]; refused: typeof NOT_MALFORMED[] };
  let made: typeof MADE | { refusal: string };
  let removed: string[];
  let notRemoved: string | undefined;
  const repairIn = (sourceMods: Record<string, string>, force = false, agrees?: (dropping: readonly PluginRepairPreview[]) => Promise<boolean>) => {
    const previewed: PluginRepairPreview[] = [];
    const newRepositories = {
      of: (mod: string) => Promise.resolve(mod === 'Harbor' ? made : { refusal: 'unasked' }),
      folderManifestRemovedOrWhy: ({ folder }: { folder: string }) => { removed.push(folder); return Promise.resolve(notRemoved); },
    };
    const result = pluginCommandsWith(fakeInstanceAdapter(readingFixture({ sourceMods: sourceModsOf(sourceMods) })).adapter, client, newRepositories)
      .decompileAndRepair([MALFORMED, CLEAN], force, (preview) => previewed.push(preview), agrees);
    return { previewed, result };
  };
  const repair = (force = false, agrees?: (dropping: readonly PluginRepairPreview[]) => Promise<boolean>) => repairIn({}, force, agrees);
  const repairedWith = () => client.calls.filter((call) => call.method === 'decompileAndRepair').map((call) => ({ force: call.args[1], agreedDrops: call.args[2] }));
  const landingOnlyAForcedPreviewedHash: MEditClient['decompileAndRepair'] = (plugins, force, agreedDrops) => Promise.resolve({
    landed: plugins.filter(({ plugin, hash }) => previews.landed.some((p) => p.plugin === plugin && p.hash === hash) && (force || agreedDrops)).map(({ plugin }) => plugin),
    refused: [],
  });

  beforeEach(() => {
    client = new InMemoryMEditClient();
    previews = { landed: [PREVIEW], refused: [NOT_MALFORMED] };
    client.setCommandHandler('repairPreviews', () => Promise.resolve(previews));
    client.setCommandHandler('decompileAndRepair', landingOnlyAForcedPreviewedHash);
    made = MADE;
    removed = [];
    notRemoved = undefined;
  });

  it('hands each preview over before the repair, then repairs each by its hash, a mod with no repository handed the one decompile and commit makes', async () => {
    const { previewed, result } = repair(true);

    expect(await result).toEqual({ applied: true, outcome: { landed: [MALFORMED], refused: [NOT_MALFORMED] } });
    expect(previewed).toEqual([PREVIEW]);
    expect(client.calls.find((call) => call.method === 'decompileAndRepair')?.args[0]).toEqual([{ plugin: MALFORMED, hash: 'abc', newRepository: MADE.repository }]);
    expect(removed).toEqual([MADE.folder]);
  });

  it('hands a mod a repository builds no new one, and removes no manifest of its folder', async () => {
    await repairIn({ Harbor: '/source/Harbor' }, true).result;

    expect(client.calls.find((call) => call.method === 'decompileAndRepair')?.args[0]).toEqual([{ plugin: MALFORMED, hash: 'abc' }]);
    expect(removed).toEqual([]);
  });

  it('refuses a plugin whose mod has no repository and cannot be given one, naming why, and repairs nothing for it', async () => {
    made = { refusal: 'its metadata could not be read: EACCES' };

    const outcome = await repair(true).result;

    expect(outcome).toEqual({ applied: true, outcome: { landed: [], refused: [NOT_MALFORMED, { item: MALFORMED, reason: 'Harbor has no repository, and one cannot be made: its metadata could not be read: EACCES' }] } });
    expect(client.calls.map((call) => call.method)).toEqual(['repairPreviews']);
  });

  it('names a repaired plugin whose mod folder\'s manifest could not be removed once its repository was made', async () => {
    notRemoved = 'the manifest in its folder could not be removed: EACCES';

    const outcome = await repair(true).result;

    expect(outcome).toEqual({ applied: true, outcome: { landed: [MALFORMED], refused: [NOT_MALFORMED, { item: MALFORMED, reason: `was repaired, but ${notRemoved}` }] } });
  });

  it('repairs nothing when no plugin previewed', async () => {
    previews = { landed: [], refused: [NOT_MALFORMED] };

    expect(await repair().result).toEqual({ applied: true, outcome: { landed: [], refused: [NOT_MALFORMED] } });
    expect(client.calls.map((call) => call.method)).toEqual(['repairPreviews']);
  });

  describe('a preview that drops data', () => {
    const LOSSLESS = { diagnosis: { anchor: 'REGN 00000801 (Harbor)', defectClass: 'short', message: 'XYZ is 2 bytes' }, change: { description: 'pads XYZ', dropsData: false } };
    const LOSSY = { diagnosis: { anchor: 'REGN 00000800 (Harbor)', defectClass: 'long', message: 'RDAT is long' }, change: DROPS };
    const dropping: PluginRepairPreview = { ...PREVIEW, diagnoses: [LOSSLESS, LOSSY] };
    beforeEach(() => { previews = { landed: [dropping], refused: [] }; });

    it('is repaired, with the drops agreed and no force, once the user agrees to exactly the changes that drop data', async () => {
      const heard: (readonly PluginRepairPreview[])[] = [];

      const { result } = repair(false, (changes) => { heard.push(changes); return Promise.resolve(true); });

      expect(await result).toEqual({ applied: true, outcome: { landed: [MALFORMED], refused: [] } });
      expect(heard).toEqual([[{ ...dropping, diagnoses: [LOSSY] }]]);
      expect(repairedWith()).toEqual([{ force: false, agreedDrops: true }]);
    });

    it('writes nothing when the user does not agree', async () => {
      const { result } = repair(false, () => Promise.resolve(false));

      expect(await result).toEqual({ applied: true, outcome: { landed: [], refused: [] } });
      expect(client.calls.map((call) => call.method)).toEqual(['repairPreviews']);
    });

    it('asks nothing of a forced repair', async () => {
      const agrees = vi.fn(() => Promise.resolve(true));

      await repair(true, agrees).result;

      expect(agrees).not.toHaveBeenCalled();
      expect(repairedWith()).toEqual([{ force: true, agreedDrops: false }]);
    });

    it('without a way to ask, leaves the refusal to mEdit', async () => {
      await repair(false).result;

      expect(repairedWith()).toEqual([{ force: false, agreedDrops: false }]);
    });
  });

  it('asks nothing when no change drops data', async () => {
    const agrees = vi.fn(() => Promise.resolve(true));

    await repair(false, agrees).result;

    expect(agrees).not.toHaveBeenCalled();
    expect(repairedWith()).toEqual([{ force: false, agreedDrops: false }]);
  });

  it('names each change with its record, and a diagnosis no change answers', () => {
    expect(previewLines({ ...PREVIEW, diagnoses: [...PREVIEW.diagnoses, { diagnosis: { defectClass: 'shape', message: 'EPFT 2' }, change: null }] })).toEqual([
      'Malformed.esp (Harbor): REGN 00000800 (Harbor): pads RDAT from 6 to 8 bytes with zeros',
      'Malformed.esp (Harbor): the plugin: no repair answers EPFT 2',
    ]);
  });
});
