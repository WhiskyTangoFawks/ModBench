import { afterEach, describe, expect, it } from 'vitest';
import { toldAfter, withoutTelling, writesToldTo } from '../writesTold';

const told: (readonly string[])[] = [];

afterEach(() => {
  told.length = 0;
  writesToldTo({ told: () => Promise.resolve() });
});

const loaderTold = (answer: () => Promise<void> = () => Promise.resolve()): void => {
  writesToldTo({ told: (paths) => { told.push(paths); return answer(); } });
};

describe('a write the loader is told of', () => {
  it('tells the files after it has written them', async () => {
    loaderTold();
    const steps: string[] = [];

    await toldAfter(['/a'], () => { steps.push('write'); return Promise.resolve(); });

    expect({ steps, told }).toEqual({ steps: ['write'], told: [['/a']] });
  });

  it('still tells the files of a write that fails halfway, and fails with its own failure whatever the loader answers', async () => {
    loaderTold(() => Promise.reject(new Error('read failed')));

    await expect(toldAfter(['/a'], () => Promise.reject(new Error('disk full')))).rejects.toThrow('disk full');

    expect(told).toEqual([['/a']]);
  });

  it('fails with the loader\'s failure when the write succeeded and the read that was to hold it did not', async () => {
    loaderTold(() => Promise.reject(new Error('read failed')));

    await expect(toldAfter(['/a'], () => Promise.resolve())).rejects.toThrow('read failed');
  });

  it('tells nothing of a write made without telling, or of no files', async () => {
    loaderTold();

    await withoutTelling(() => toldAfter(['/a'], () => Promise.resolve()));
    await toldAfter([], () => Promise.resolve());

    expect(told).toEqual([]);
  });
});
