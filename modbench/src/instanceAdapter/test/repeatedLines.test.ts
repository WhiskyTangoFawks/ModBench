import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cloneCorpusFixture, DEFAULT_MODLIST } from '../../test/mo2/corpusFixture';
import { readInstanceOf } from '../../test/mo2/adapterOver';

describe('a line the instance repeats', () => {
  let dir: string;
  beforeEach(() => { dir = cloneCorpusFixture(); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it.each([
    { what: 'mod', file: DEFAULT_MODLIST, line: '-Patch Mod', note: 'modlist.txt lists the mod Patch Mod' },
    { what: 'mod, whatever its case', file: DEFAULT_MODLIST, line: '+PATCH MOD', note: 'modlist.txt lists the mod PATCH MOD' },
    { what: 'separator', file: DEFAULT_MODLIST, line: '+Unassigned (Modlist Development)_separator', note: 'modlist.txt lists the separator Unassigned (Modlist Development)' },
    { what: 'separator, whatever its case', file: DEFAULT_MODLIST, line: '-UNASSIGNED (MODLIST DEVELOPMENT)_separator', note: 'modlist.txt lists the separator UNASSIGNED (MODLIST DEVELOPMENT)' },
  ])('is one $what in the reading, the first line holding, and a note names the repeat', async ({ file, line, note }) => {
    const before = await readInstanceOf(dir);
    await appendFile(join(dir, file), `${line}\n`);

    const reading = await readInstanceOf(dir);

    expect({ mods: reading.mods, pluginOrder: reading.pluginOrder }).toEqual({ mods: before.mods, pluginOrder: before.pluginOrder });
    expect(reading.orderNotes).toEqual([`${note} on more than one line; the first line holds`]);
  });
});
