import { describe, it, expect } from 'vitest';
import { createWriteQueue } from './writeQueue';

// A task that finishes only when the test says so, so an overlap is arranged rather than raced.
function gate(): { task: () => Promise<string>; started: Promise<void>; finish: () => void } {
  let release = () => {};
  let announce = () => {};
  const started = new Promise<void>((r) => { announce = r; });
  const blocked = new Promise<void>((r) => { release = r; });
  return {
    task: async () => {
      announce();
      await blocked;
      return 'done';
    },
    started,
    finish: () => release(),
  };
}

describe('createWriteQueue', () => {
  it('holds a second task on the same key until the first has finished', async () => {
    const run = createWriteQueue();
    const first = gate();
    const order: string[] = [];

    const firstRun = run('a', async () => { order.push(await first.task()); });
    await first.started;
    const secondRun = run('a', () => { order.push('second'); return Promise.resolve(); });

    expect(order).toEqual([]);
    first.finish();
    await Promise.all([firstRun, secondRun]);
    expect(order).toEqual(['done', 'second']);
  });

  it('runs two keys at once: one file waiting never holds another up', async () => {
    const run = createWriteQueue();
    const held = gate();

    const heldRun = run('a', held.task);
    await held.started;
    await expect(run('b', () => Promise.resolve('b ran'))).resolves.toBe('b ran');

    held.finish();
    await heldRun;
  });

  it('two queues are independent, so one caller’s file never waits on another’s', async () => {
    const first = createWriteQueue();
    const second = createWriteQueue();
    const held = gate();

    const heldRun = first('same key', held.task);
    await held.started;
    await expect(second('same key', () => Promise.resolve('ran'))).resolves.toBe('ran');

    held.finish();
    await heldRun;
  });

  it('a rejected task is the caller’s alone: the next task on that key still runs', async () => {
    const run = createWriteQueue();

    await expect(run('a', () => Promise.reject(new Error('EPERM')))).rejects.toThrow('EPERM');
    await expect(run('a', () => Promise.resolve('after'))).resolves.toBe('after');
  });

  it('forgets a key once its chain settles, so the map does not grow with every write', async () => {
    const run = createWriteQueue();
    const held = gate();

    const heldRun = run('a', held.task);
    await held.started;
    expect(run.held()).toEqual(['a']);

    held.finish();
    await heldRun;
    await Promise.resolve();
    expect(run.held()).toEqual([]);
  });

  it('keeps the key while a task is still queued behind the one that settled', async () => {
    const run = createWriteQueue();
    const first = gate();
    const second = gate();

    const firstRun = run('a', first.task);
    await first.started;
    const secondRun = run('a', second.task);
    first.finish();
    await second.started;

    expect(run.held()).toEqual(['a']);
    second.finish();
    await Promise.all([firstRun, secondRun]);
  });
});
