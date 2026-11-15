import { describe, expect, it } from 'vitest';
import { ambientWrites, collectingWrites } from '../ambientWrites';
import { WrittenFiles } from '../writtenFiles';

const naming = (...paths: string[]) => () => { ambientWrites.name(paths); return Promise.resolve(); };

describe('the writes of the command running', () => {
  it('name their files to the collector of the command, across its awaits', async () => {
    const written = new WrittenFiles();

    await collectingWrites(written, async () => {
      ambientWrites.name(['/a']);
      await Promise.resolve();
      ambientWrites.name(['/b']);
    });

    expect(written.named).toEqual(['/a', '/b']);
  });

  it('name nothing to a collector once its command has ended', async () => {
    const written = new WrittenFiles();
    await collectingWrites(written, () => Promise.resolve());

    ambientWrites.name(['/outside']);

    expect(written.named).toEqual([]);
  });

  it('name each file to the collector of its own command when two run together', async () => {
    const [first, second] = [new WrittenFiles(), new WrittenFiles()];
    let release!: () => void;
    const heldUp = new Promise<void>((resolve) => { release = resolve; });

    const firstRun = collectingWrites(first, async () => { await heldUp; ambientWrites.name(['/first']); });
    await collectingWrites(second, naming('/second'));
    release();
    await firstRun;

    expect([first.named, second.named]).toEqual([['/first'], ['/second']]);
  });

  it('name their files to a collector around the command too', async () => {
    const [around, inner] = [new WrittenFiles(), new WrittenFiles()];

    await collectingWrites(around, () => collectingWrites(inner, naming('/nested')));

    expect([around.named, inner.named]).toEqual([['/nested'], ['/nested']]);
  });

  it('leave the files of a collector around the command unnamed too', async () => {
    const [around, inner] = [new WrittenFiles(), new WrittenFiles()];

    await collectingWrites(around, () => collectingWrites(inner, () => { ambientWrites.name(['/a']); ambientWrites.leaveUnnamed(); return Promise.resolve(); }));

    expect(around.named).toBeUndefined();
  });
});
