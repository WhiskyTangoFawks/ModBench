import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWithin, overlappedGameRoot } from '../pathWithin';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'within-'));
  await mkdir(join(root, 'Fallout4', 'Data'), { recursive: true });
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe('isWithin', () => {
  it.each([
    ['the folder itself', 'Fallout4', 'Fallout4', true],
    ['a folder below it', 'Fallout4', 'Fallout4/Data', true],
    ['a folder beside it whose name starts with its name', 'Fallout4', 'Fallout4 deployed', false],
    ['a folder above it', 'Fallout4/Data', 'Fallout4', false],
  ])('answers for %s', async (_case, folder, path, within) => {
    expect(await isWithin(join(root, folder), join(root, path))).toBe(within);
  });

  it('resolves a link, so a folder reached through one is within its target', async () => {
    await symlink(join(root, 'Fallout4'), join(root, 'link'));

    expect(await isWithin(join(root, 'Fallout4'), join(root, 'link', 'Data'))).toBe(true);
  });
});

describe('overlappedGameRoot', () => {
  const game = (): { kind: 'found'; root: string } => ({ kind: 'found', root: join(root, 'Fallout4') });

  it.each([['is it', 'Fallout4'], ['holds it', '.'], ['sits inside it', 'Fallout4/Data']])('answers the game root when the folder %s', async (_case, folder) => {
    expect(await overlappedGameRoot(game(), join(root, folder))).toBe(join(root, 'Fallout4'));
  });

  it('answers none for a folder beside it, and for a game folder not found', async () => {
    expect([await overlappedGameRoot(game(), join(root, 'Fallout4 deployed')), await overlappedGameRoot({ kind: 'notFound' }, root)]).toEqual([undefined, undefined]);
  });
});
