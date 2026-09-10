// The installer writes no modlist line, so this watcher is what puts one there. Reproduced
// against a real instance directory and the real reconcileMods command, with only the vscode
// watcher faked.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchers, fakeVscodeModule } from './test/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { registerModsReconcile } from './modsReconcile';
import { reconcileMods } from './commands/modlist';
import { installFromFolder } from './commands/install';
import { cloneCorpusFixture, DEFAULT_MODLIST } from './test/corpusFixture';

const MOD = 'Freshly Installed Mod';

const modlistText = (root: string): Promise<string> => readFile(join(root, DEFAULT_MODLIST), 'utf8');

describe('registerModsReconcile', () => {
  let root: string;
  let sourceFolder: string;
  let invalidate: ReturnType<typeof vi.fn>;
  let channel: { error: ReturnType<typeof vi.fn> };
  let subscription: { dispose(): void };

  beforeEach(async () => {
    watchers.length = 0;
    root = await cloneCorpusFixture();
    sourceFolder = await mkdtemp(join(tmpdir(), 'medit-install-source-'));
    await writeFile(join(sourceFolder, 'Installed.esp'), 'plugin bytes');
    invalidate = vi.fn();
    channel = { error: vi.fn() };
    subscription = registerModsReconcile(root, () => reconcileMods(root, 'Default'), invalidate, channel);
  });
  afterEach(async () => {
    subscription.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(sourceFolder, { recursive: true, force: true });
  });

  it('watches mods/** under the instance root', () => {
    expect(watchers.map((w) => w.pattern)).toEqual(['mods/**']);
  });

  // Rival: drop the watcher, or its registration half. Nothing else writes the line, so the
  // install stays unlisted forever.
  it('registers the folder an install dropped in, off the mods/ event alone', async () => {
    const outcome = await installFromFolder(root, { kind: 'new', name: MOD }, sourceFolder);
    expect(outcome).toMatchObject({ applied: true });
    expect(await modlistText(root)).not.toContain(MOD); // the installer wrote no line

    watchers[0].fireCreate(join(root, 'mods', MOD, 'Installed.esp'));

    await vi.waitFor(async () => expect(await modlistText(root)).toContain(MOD));
    expect(invalidate).toHaveBeenCalled();
  });

  it('prunes the entry of a mod folder deleted outside Modbench', async () => {
    await rm(join(root, 'mods', 'Harder VATS'), { recursive: true, force: true });

    watchers[0].fireDelete(join(root, 'mods', 'Harder VATS'));

    await vi.waitFor(async () => expect(await modlistText(root)).not.toContain('Harder VATS'));
  });

  it('is idempotent — a further event once disk and modlist.txt agree changes nothing', async () => {
    watchers[0].fireCreate(join(root, 'mods', 'DragIn Manual Extract'));
    // The whole reconcile, not just its first write: `invalidate` fires once both legs land.
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    const settled = await modlistText(root);
    expect(settled).toContain('DragIn Manual Extract');
    invalidate.mockClear();

    watchers[0].fireChange(join(root, 'mods', 'Harder VATS', 'HarderVATS.esp'));
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(await modlistText(root)).toBe(settled);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('logs a reconcile failure instead of throwing out of the watcher callback', async () => {
    await rm(join(root, DEFAULT_MODLIST));

    expect(() => watchers[0].fireCreate(join(root, 'mods', MOD))).not.toThrow();

    await vi.waitFor(() => expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('ENOENT')));
  });
});
