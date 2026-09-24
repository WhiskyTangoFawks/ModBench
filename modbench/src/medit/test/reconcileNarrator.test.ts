import { describe, it, expect, vi } from 'vitest';
import type { LoadOrderProgress } from '../../client';
import { createReconcileNarrator } from '../reconcileNarrator';

const tick = (over: Partial<LoadOrderProgress> = {}): LoadOrderProgress => ({
  totalPlugins: 2, version: 3, indexedPlugins: [], conflictsComputed: false, failures: [], holdsNone: false, ...over,
});
const dropped = (version = 3) => tick({ holdsNone: true, totalPlugins: 0, version });
const ready = (version = 3) => tick({ conflictsComputed: true, indexedPlugins: ['A.esp', 'B.esp'], version });

function narrated(settle: (status: LoadOrderProgress) => Promise<void> = () => Promise.resolve()) {
  const progress: { closed: boolean }[] = [];
  const deps = {
    showProgress: vi.fn((until: Promise<void>) => {
      const span = { closed: false };
      progress.push(span);
      void until.then(() => { span.closed = true; });
    }),
    applyIndexed: vi.fn(),
    setStatusText: vi.fn(),
    settle: vi.fn(settle),
    log: vi.fn(),
  };
  return { deps, progress, narrator: createReconcileNarrator(deps) };
}

const flushed = () => new Promise((resolve) => setTimeout(resolve, 0));

// plugins.md, States 2: the view's progress and each row's indexed state follow the index status,
// whoever started the reconcile — a put, a rebuild's refill or the watcher.
describe('the reconcile narrator', () => {
  it('shows a rebuild-started refill: rows reset to still indexing, progress while it runs, cleared on Ready', async () => {
    const { deps, progress, narrator } = narrated();
    narrator.hear(ready());
    await flushed();
    deps.settle.mockClear();

    narrator.hear(dropped());
    expect(deps.applyIndexed).toHaveBeenLastCalledWith([], []);
    narrator.hear(tick());
    narrator.hear(tick({ indexedPlugins: ['A.esp'] }));
    await flushed();
    expect(progress).toEqual([{ closed: false }]);
    expect(deps.applyIndexed).toHaveBeenLastCalledWith(['A.esp'], []);

    narrator.hear(ready());
    await flushed();

    expect(progress).toEqual([{ closed: true }]);
    expect(deps.settle).toHaveBeenCalledWith(ready());
  });

  it('opens one progress for a reconcile, however many ticks it publishes', async () => {
    const { progress, narrator } = narrated();

    narrator.hear(tick());
    narrator.hear(tick({ indexedPlugins: ['A.esp'] }));
    narrator.hear(tick({ indexedPlugins: ['A.esp', 'B.esp'] }));
    await flushed();

    expect(progress).toHaveLength(1);
  });

  it('settles a Ready answering a newer version, with no reconcile seen in progress', async () => {
    const { deps, narrator } = narrated();
    narrator.hear(ready(3));
    await flushed();

    narrator.hear(ready(4));
    await flushed();

    expect(deps.settle).toHaveBeenCalledTimes(2);
  });

  // A put's own answer is a status too, heard beside the stream's: a Ready heard from both while the
  // first hand-off still runs is handed over once.
  it('hands over a Ready heard twice while its hand-off runs, once', async () => {
    let handedOver!: () => void;
    const { deps, narrator } = narrated(() => new Promise<void>((resolve) => { handedOver = resolve; }));

    narrator.hear(ready(3));
    narrator.hear(ready(3));
    await flushed();
    handedOver();
    await flushed();

    expect(deps.settle).toHaveBeenCalledTimes(1);
  });

  it('settles nothing for a Ready repeating a version already handed over', async () => {
    const { deps, narrator } = narrated();
    narrator.hear(ready(3));
    await flushed();

    narrator.hear(ready(3));
    await flushed();

    expect(deps.settle).toHaveBeenCalledTimes(1);
  });

  it('closes the progress on a refusal and says so in the status bar, handing nothing over', async () => {
    const { deps, progress, narrator } = narrated();
    narrator.hear(tick());

    narrator.hear(tick({ refusalMessage: 'another Modbench window holds this instance' }));
    await flushed();

    expect(progress).toEqual([{ closed: true }]);
    expect(deps.setStatusText).toHaveBeenCalledWith('$(error) mEdit: another Modbench window holds this instance');
    expect(deps.settle).not.toHaveBeenCalled();
  });

  it('answers settled(version) once that version is handed to the views, not when its Ready is heard', async () => {
    let handedOver!: () => void;
    const { narrator } = narrated(() => new Promise<void>((resolve) => { handedOver = resolve; }));
    let settled = false;
    void narrator.settled(3).then(() => { settled = true; });

    narrator.hear(ready(3));
    await flushed();
    expect(settled).toBe(false);

    handedOver();
    await flushed();
    expect(settled).toBe(true);
  });

  it('answers settled(version) at once for a version already handed over', async () => {
    const { narrator } = narrated();
    narrator.hear(ready(3));
    await flushed();

    await expect(narrator.settled(2)).resolves.toBeUndefined();
  });
});

// toolbox.md, Refresh: the view's progress while it runs, and the rebuild's 204 answers before the
// refill has read anything.
describe('the reconcile narrator: the refill a rebuild starts', () => {
  it('ends the wait at the refill\'s Ready, not before it', async () => {
    const { narrator } = narrated();
    narrator.hear(ready());
    await flushed();
    let refilled = false;
    void narrator.nextRefill().then(() => { refilled = true; });

    narrator.hear(ready());
    narrator.hear(dropped());
    narrator.hear(tick());
    await flushed();
    expect(refilled).toBe(false);

    narrator.hear(ready());
    await flushed();
    expect(refilled).toBe(true);
  });

  it('ends the wait at once when the index held nothing to refill', async () => {
    const { narrator } = narrated();
    narrator.hear(dropped());

    await expect(narrator.nextRefill()).resolves.toBeUndefined();
  });

  it('ends the wait when a refusal ends the refill', async () => {
    const { narrator } = narrated();
    narrator.hear(ready());
    const refilled = narrator.nextRefill();

    narrator.hear(dropped());
    narrator.hear(tick({ refusalMessage: 'another window' }));

    await expect(refilled).resolves.toBeUndefined();
  });

  it('hands over the next process\'s first Ready, though its version is one already handed over', async () => {
    const { deps, narrator } = narrated();
    narrator.hear(ready(5));
    await flushed();

    narrator.detached();
    narrator.hear(ready(1));
    await flushed();

    expect(deps.settle).toHaveBeenCalledTimes(2);
  });

  it('closes the progress and ends every wait when mEdit goes away', async () => {
    const { progress, narrator } = narrated();
    narrator.hear(ready());
    const refilled = narrator.nextRefill();
    const settled = narrator.settled(9);
    narrator.hear(tick());

    narrator.detached();
    await flushed();

    expect(progress).toEqual([{ closed: true }]);
    await expect(refilled).resolves.toBeUndefined();
    await expect(settled).resolves.toBeUndefined();
  });
});
