import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { watchers, fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../test/mo2/adapterOver';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';

vi.mock('vscode', () => fakeVscodeModule());

const SETTINGS_FILE = 'compiler_settings.json';

describe('the Instance adapter the build composes: the mod manager\'s implementation beside the publisher\'s (ADR-0024)', () => {
  const root = cloneCorpusFixture();

  afterEach(async () => {
    watchers.length = 0;
    await rm(join(root, SETTINGS_FILE), { force: true });
  });

  afterAll(() => rm(root, { recursive: true, force: true }));

  it('declares the publisher\'s tags, and reads its configuration in the same reading as the mod manager\'s files', async () => {
    await writeFile(join(root, SETTINGS_FILE), JSON.stringify({ Include: ['mods\\Harder VATS'] }));
    const adapter = adapterOver(root);

    const { profile, publisherConfiguration } = await adapter.reading();

    expect({
      declared: adapter.publisherTags.map(({ badge }) => badge),
      profile,
      covering: publisherConfiguration.kind === 'read' && publisherConfiguration.covering(join(root, 'mods', 'Harder VATS'), false).map(({ badge }) => badge),
    }).toEqual({ declared: ['NM', 'IN', 'IG', 'AE'], profile: 'Default', covering: ['IN'] });
  });

  it('gives the publisher the mod manager\'s Overwrite as a folder it never ships', async () => {
    await writeFile(join(root, SETTINGS_FILE), JSON.stringify({ Include: ['overwrite'] }));

    const { publisherConfiguration } = await adapterOver(root).reading();

    expect(publisherConfiguration.kind === 'read' && publisherConfiguration.covering(join(root, 'overwrite', 'x.ini'), false)).toEqual([]);
  });

  it('hears a change to the publisher\'s configuration and to the mod manager\'s files alike, and neither once the listener leaves', () => {
    let signals = 0;
    const subscription = adapterOver(root).subscribe(() => { signals++; });
    const live = () => watchers.filter((watcher) => !watcher.disposed);
    const firedOn = (pattern: string): void => { live().find((watcher) => watcher.pattern === pattern)?.fireChange(); };

    firedOn(SETTINGS_FILE);
    firedOn('ModOrganizer.ini');
    subscription.dispose();

    expect({ signals, armed: live().length }).toEqual({ signals: 2, armed: 0 });
  });
});
