import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { MEditClient, PluginRepairPreview } from '../../client';
import { previewLines } from '../decompileAndRepair';

const MALFORMED = { name: 'Malformed.esp', origin: 'Harbor' };
const CLEAN = { name: 'Clean.esp', origin: 'Harbor' };
const NOT_MALFORMED = { item: CLEAN, reason: 'Clean.esp is not malformed.' };
const PREVIEW: PluginRepairPreview = {
  plugin: MALFORMED, hash: 'abc',
  diagnoses: [{ diagnosis: { anchor: 'REGN 00000800 (Harbor)', defectClass: 'short', message: 'RDAT is 6 bytes' }, change: { description: 'pads RDAT from 6 to 8 bytes with zeros', droppedBytes: 0 } }],
};

describe('decompileAndRepair — the preview, then the repair of each plugin it previewed', () => {
  let client: InMemoryMEditClient;
  let previews: { landed: PluginRepairPreview[]; refused: typeof NOT_MALFORMED[] };
  const repair = (force = false) => {
    const previewed: PluginRepairPreview[] = [];
    const result = pluginCommandsWith(fakeInstanceAdapter(readingFixture()).adapter, client)
      .decompileAndRepair([MALFORMED, CLEAN], force, (preview) => previewed.push(preview));
    return { previewed, result };
  };
  const landingOnlyAForcedPreviewedHashInItsModsSourceFolder: MEditClient['decompileAndRepair'] = (plugins, metadataFiles, force) => Promise.resolve({
    landed: plugins.filter(({ plugin, hash, sourceFolder }) =>
      previews.landed.some((p) => p.plugin === plugin && p.hash === hash) && sourceFolder === `/source/${plugin.origin}` && force
      && metadataFiles.includes('meta.ini')).map(({ plugin }) => plugin),
    refused: [],
  });

  beforeEach(() => {
    client = new InMemoryMEditClient();
    previews = { landed: [PREVIEW], refused: [NOT_MALFORMED] };
    client.setCommandHandler('repairPreviews', () => Promise.resolve(previews));
    client.setCommandHandler('decompileAndRepair', landingOnlyAForcedPreviewedHashInItsModsSourceFolder);
  });

  it('hands each preview over before the repair, then repairs each by its hash in the folder the adapter names for its mod', async () => {
    const { previewed, result } = repair(true);

    expect(await result).toEqual({ applied: true, outcome: { landed: [MALFORMED], refused: [NOT_MALFORMED] } });
    expect(previewed).toEqual([PREVIEW]);
  });

  it('repairs nothing when no plugin previewed', async () => {
    previews = { landed: [], refused: [NOT_MALFORMED] };

    expect(await repair().result).toEqual({ applied: true, outcome: { landed: [], refused: [NOT_MALFORMED] } });
    expect(client.calls.map((call) => call.method)).toEqual(['repairPreviews']);
  });

  it('names each change with its record, and a diagnosis no change answers', () => {
    expect(previewLines({ ...PREVIEW, diagnoses: [...PREVIEW.diagnoses, { diagnosis: { defectClass: 'shape', message: 'EPFT 2' }, change: null }] })).toEqual([
      'Malformed.esp: REGN 00000800 (Harbor): pads RDAT from 6 to 8 bytes with zeros',
      'Malformed.esp: the plugin: no repair answers EPFT 2',
    ]);
  });
});
