import { afterEach, describe, expect, it, vi } from 'vitest';
import { toldAfter, toldOnceSettled, writesToldTo } from '../writesTold';

const told: (readonly string[])[] = [];

afterEach(() => {
  told.length = 0;
  writesToldTo({ told: () => Promise.resolve({ subscribed: Promise.resolve() }) });
});

const loaderTold = (answer: () => Promise<void> = () => Promise.resolve()): void => {
  writesToldTo({ told: async (paths) => { told.push(paths); await answer(); return { subscribed: Promise.resolve() }; } });
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

  it('answers once the read that was to hold the write failed, which the loader tells, so the command goes on (common.md, A gesture that writes, story 3)', async () => {
    loaderTold(() => Promise.reject(new Error('read failed')));

    const answered = await toldAfter(['/a'], () => Promise.resolve('written'));

    expect([answered, told]).toEqual(['written', [['/a']]]);
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
