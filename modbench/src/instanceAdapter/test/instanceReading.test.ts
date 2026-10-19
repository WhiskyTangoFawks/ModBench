import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cloneCorpusFixture, DEFAULT_MODLIST } from '../../test/mo2/corpusFixture';
import { sourceOver } from '../../test/mo2/adapterOver';
import { readInstance } from '../instanceReading';

describe('the instance assembled from a manager\'s reading', () => {
  let dir: string;
  beforeEach(() => { dir = cloneCorpusFixture(); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('names the manager\'s mod order file in a repeat note, and takes the manager\'s key for what repeats', async () => {
    await appendFile(join(dir, DEFAULT_MODLIST), '-Patch Mod\n+PATCH MOD\n');
    const source = {
      ...sourceOver(dir),
      names: { manager: 'Other', modOrderFile: 'order.txt', downloadMetadataFile: '.sidecar' },
      modLineKey: ({ kind, name }: { kind: string; name: string }) => `${kind}:${name}`,
    };

    const { orderNotes } = await readInstance(source);

    expect(orderNotes).toEqual(['order.txt lists the mod Patch Mod on more than one line; the first line holds']);
  });
});
