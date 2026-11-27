import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commandHandlers, editorVscode, showQuickPick, type QuickPickItemLike } from './editorVscode';

vi.mock('vscode', () => editorVscode);

import type { PluginAddress, PluginMetadata, RecordAt } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import { recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { forgetEditor, register } from './editorHarness';

function plugin(name: string, origin: string, loadOrderIndex: number | null, facts: Partial<PluginMetadata> = {}): PluginMetadata {
  return pluginMetadataFixture({ name, origin, loadOrderIndex, isCompiledPlugin: true, isImmutable: false, ...facts });
}

const npc: RecordAt = { formKey: '000801:Source.esp', plugin: { name: 'Source.esp', origin: 'SourceMod' } };
const faction: RecordAt = { formKey: '000802:Source.esp', plugin: { name: 'Source.esp', origin: 'SourceMod' } };
const elsewhere: RecordAt = { formKey: '000803:Other.esp', plugin: { name: 'Other.esp', origin: 'OtherMod' } };
const rowOf = ({ formKey, plugin: of }: RecordAt) => ({ argument: { kind: 'record', plugin: of, formKey } });

beforeEach(forgetEditor);

const hasMode = (mode: string) => (item: QuickPickItemLike) => item.mode === mode;

function copying(client: InMemoryMEditClient, ...answers: (string | undefined)[]) {
  const reporter = recordingReporter();
  const ask = scriptedDialog(...answers);
  register({ meditClient: client, reporterOf: reporter, ask });
  const copy = async (records: readonly RecordAt[]) => {
    await commandHandlers.get('modbench.record.copy')?.(rowOf(records[0] ?? npc), records.map(rowOf));
  };
  return { copy, reporter, ask };
}

async function offered(plugins: readonly PluginMetadata[], mode: string, records: readonly RecordAt[]): Promise<readonly QuickPickItemLike[]> {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPlugins', [...plugins]);
  let items: readonly QuickPickItemLike[] = [];
  showQuickPick.mockImplementationOnce((modes) => Promise.resolve(modes.find(hasMode(mode))));
  showQuickPick.mockImplementationOnce((destinations) => { items = destinations; return Promise.resolve(undefined); });
  await copying(client).copy(records);
  return items;
}

const shown = (items: readonly QuickPickItemLike[]) => items.map(({ label, description }) => ({ label, description }));

describe('the mode pick', () => {
  it('offers override and new, override first as xEdit\'s navigator does', async () => {
    let modes: readonly QuickPickItemLike[] = [];
    showQuickPick.mockImplementationOnce((items) => { modes = items; return Promise.resolve(undefined); });

    await copying(new InMemoryMEditClient()).copy([npc]);

    expect(modes.map((item) => item.mode)).toEqual(['Override', 'New']);
  });
});

describe('the destination pick', () => {
  const plugins = [
    plugin('Source.esp', 'SourceMod', 3),
    plugin('Patch.esp', 'PatchMod', 5),
    plugin('NonCompiledPlugin.esp', 'NonSourceMod', 6, { isCompiledPlugin: false }),
    plugin('ReadOnly.esp', 'ReadOnlyMod', 7, { isImmutable: true }),
    plugin('Unreadable.esp', 'UnreadableMod', 8, { pluginSourceUnreadable: { reason: 'Its folder is gone.', decompileRepairs: true } }),
    plugin('Other.esp', 'OtherMod', 9),
  ];
  const labels = async (asked: Promise<readonly QuickPickItemLike[]>) => (await asked).map(({ label }) => label);

  it('offers the editable plugins, each with its load position, and not one with no plugin source or one whose plugin source is unreadable', async () => {
    expect(shown(await offered(plugins, 'New', [npc]))).toEqual([
      { label: 'Source.esp', description: '[3]' }, { label: 'Patch.esp', description: '[5]' }, { label: 'Other.esp', description: '[9]' },
    ]);
  });

  it('offers a plugin that is not active, described as `(not active)` in place of a load position', async () => {
    const disabled = plugin('Disabled.esp', 'DisabledMod', null, { inLoadOrder: false });

    expect(shown(await offered([disabled], 'New', [npc]))).toEqual([{ label: 'Disabled.esp', description: '(not active)' }]);
  });

  it('names each plugin\'s origin in its detail, so two plugins that share a file name are two rows apart', async () => {
    const winning = plugin('Shared.esp', 'WinningMod', 4);
    const overridden = plugin('Shared.esp', 'OverriddenMod', null, { inLoadOrder: false });

    expect((await offered([winning, overridden], 'New', [npc])).map(({ label, description, detail }) => ({ label, description, detail }))).toEqual([
      { label: 'Shared.esp', description: '[4]', detail: 'WinningMod' }, { label: 'Shared.esp', description: '(not active)', detail: 'OverriddenMod' },
    ]);
  });

  it('carries each plugin as (name, origin)', async () => {
    expect((await offered(plugins, 'New', [npc])).map((item) => item.plugin)).toContainEqual({ name: 'Patch.esp', origin: 'PatchMod' });
  });

  it('does not offer an override the plugin every record already lives in', async () => {
    expect(await labels(offered(plugins, 'Override', [npc, faction]))).toEqual(['Patch.esp', 'Other.esp']);
  });

  it('knows the plugin every record lives in whatever the case of its origin', async () => {
    const shouted = { ...npc, plugin: { name: 'Source.esp', origin: 'SOURCEMOD' } };

    expect(await labels(offered(plugins, 'Override', [shouted]))).toEqual(['Patch.esp', 'Other.esp']);
  });

  it('offers every editable plugin to an override of records from several plugins', async () => {
    expect(await labels(offered(plugins, 'Override', [npc, elsewhere]))).toEqual(['Source.esp', 'Patch.esp', 'Other.esp']);
  });
});

describe('the copies an override would replace', () => {
  const own = { name: 'Source.esp', origin: 'SourceMod' };
  const patch = { name: 'Patch.esp', origin: 'PatchMod' };

  async function replaceAsked(holders: readonly PluginAddress[]): Promise<unknown> {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', [plugin('Source.esp', 'SourceMod', 3), plugin('Patch.esp', 'PatchMod', 5)]);
    client.setQueryAnswer('getRecordHolders', [...holders]);
    client.setCommandResult('getCopyChanges', { applied: [], refused: [] });
    showQuickPick.mockImplementationOnce((modes) => Promise.resolve(modes.find(hasMode('Override'))));
    showQuickPick.mockImplementationOnce((destinations) => Promise.resolve(destinations));
    const { copy, ask } = copying(client, 'Replace');
    await copy([npc]);
    return ask.asked.map(({ detail }) => detail);
  }

  it.each([
    ['matches a destination by its origin as well as its name, since a plugin of the same name in another mod is another plugin',
      [{ name: 'Patch.esp', origin: 'SomeOtherMod' }], []],
    ['matches a destination by name and origin whatever their case, as mEdit compares them',
      [own, { name: 'PATCH.ESP', origin: 'patchmod' }], ['000801:Source.esp in Patch.esp (PatchMod)']],
    ['leaves out a record\'s own plugin, which holds no copy to replace', [own, patch], ['000801:Source.esp in Patch.esp (PatchMod)']],
  ])('%s, in the replace question', async (_, holders, asked) => {
    expect(await replaceAsked(holders)).toEqual(asked);
  });
});

describe('the copies said to be made, leaving out a copy that would write nothing', () => {
  it('keeps a copy as new into the record\'s own plugin, which is a duplicate beside it', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', [plugin('Source.esp', 'SourceMod', 3)]);
    client.setCommandResult('getCopyChanges', { applied: [{ record: npc, destination: npc.plugin, moves: [], deletions: [], documents: [] }], refused: [] });
    showQuickPick.mockImplementationOnce((modes) => Promise.resolve(modes.find(hasMode('New'))));
    showQuickPick.mockImplementationOnce((destinations) => Promise.resolve(destinations));
    const { copy, reporter } = copying(client);

    await copy([npc]);

    expect(reporter.landings).toEqual(['Copied 000801:Source.esp into Source.esp.']);
  });
});
