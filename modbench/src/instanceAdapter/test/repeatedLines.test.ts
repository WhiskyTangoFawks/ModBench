import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cloneCorpusFixture, DEFAULT_MODLIST, DEFAULT_PLUGINS } from '../../test/mo2/corpusFixture';
import { readInstanceOf } from '../../test/mo2/adapterOver';

describe('a line the instance repeats', () => {
  let dir: string;
  beforeEach(() => { dir = cloneCorpusFixture(); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('is one mod in the reading, the first line holding, and a note names the repeat', async () => {
    const before = await readInstanceOf(dir);
    await appendFile(join(dir, DEFAULT_MODLIST), '-Tracked Patch Mod\n');

    const reading = await readInstanceOf(dir);

    expect(reading.mods).toEqual(before.mods);
    expect(reading.orderNotes).toEqual(['modlist.txt lists the mod Tracked Patch Mod on more than one line; the first line holds']);
  });

  it('is one plugin in the reading, the first line holding, whatever its case, and a note names the repeat', async () => {
    const before = await readInstanceOf(dir);
    const name = (before.pluginOrder[0]?.name ?? '').toUpperCase();
    await appendFile(join(dir, DEFAULT_PLUGINS), `${name}\n`);

    const reading = await readInstanceOf(dir);

    expect(reading.pluginOrder).toEqual(before.pluginOrder);
    expect(reading.orderNotes).toEqual([`plugins.txt lists the plugin ${name} on more than one line; the first line holds`]);
  });
});
