import { afterEach, describe, expect, it, vi } from 'vitest';
import { toldAfter, toldOnceSettled, writesToldTo } from '../writesTold';

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

  it('tells the files written inside locked work once, after the work has settled, and answers once the loader holds them', async () => {
    let answerTold!: () => void;
    loaderTold(() => new Promise((resolve) => { answerTold = resolve; }));
    const steps: string[] = [];

    const settled = toldOnceSettled(async () => {
      await toldAfter(['/a'], () => Promise.resolve());
      await toldOnceSettled(() => toldAfter(['/b'], () => Promise.resolve()));
      steps.push(`work done, told ${told.length}`);
    }).then(() => steps.push('answered'));
    await vi.waitFor(() => { expect(told).toEqual([['/a', '/b']]); });
    steps.push('loader answers');
    answerTold();
    await settled;

    expect(steps).toEqual(['work done, told 0', 'loader answers', 'answered']);
  });

  it('tells the files written inside locked work that fails, and fails with the work\'s own failure', async () => {
    loaderTold(() => Promise.reject(new Error('read failed')));

    await expect(toldOnceSettled(async () => {
      await toldAfter(['/a'], () => Promise.resolve());
      throw new Error('disk full');
    })).rejects.toThrow('disk full');

    expect(told).toEqual([['/a']]);
  });

  it('tells at once a write that starts after the locked work it was armed in has settled', async () => {
    loaderTold();
    let later!: Promise<void>;

    await toldOnceSettled(() => {
      later = new Promise((resolve) => { setTimeout(resolve, 0); }).then(() => toldAfter(['/b'], () => Promise.resolve()));
      return Promise.resolve();
    });
    await later;

    expect(told).toEqual([['/b']]);
  });

  it('tells nothing of no files', async () => {
    loaderTold();

    await toldAfter([], () => Promise.resolve());

    expect(told).toEqual([]);
  });
});
