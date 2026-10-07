import { describe, it, expect, vi } from 'vitest';
import { createSync } from '../syncFailureReport';
import { present } from '../../ports/present';

type Outcome =
  | { applied: true; added: readonly string[]; dropped: readonly string[] }
  | { applied: false; refusal: string }
  | { applied: false; toldAsInstanceState: true };

const LABELS = {
  command: 'tidy', prefix: '[tidy]', unsynced: 'order.txt is not synced', added: 'order.txt line(s) added', dropped: 'order.txt line(s) dropped',
};

function syncAnswering(...outcomes: (() => Promise<Outcome>)[]) {
  const channel = { error: vi.fn(), info: vi.fn() };
  const messageChanged = vi.fn();
  let calls = 0;
  const sync = createSync(() => present(outcomes[calls++], 'an outcome for this run')(), channel, LABELS);
  sync.onMessageChanged(messageChanged);
  const run = async (): Promise<void> => {
    expect(() => { void sync.run({}); }).not.toThrow();
    await sync.settled();
  };
  return { channel, messageChanged, sync, run };
}

const refused = (refusal: string) => () => Promise.resolve<Outcome>({ applied: false, refusal });
const landed = () => Promise.resolve<Outcome>({ applied: true, added: [], dropped: [] });
const toldAsInstanceState = () => Promise.resolve<Outcome>({ applied: false, toldAsInstanceState: true });

describe('createSync: settled', () => {
  it('resolves once every run begun has written its Output', async () => {
    const channel = { error: vi.fn(), info: vi.fn() };
    let answer = (): void => {};
    const answered = new Promise<Outcome>((resolve) => { answer = () => resolve({ applied: true, added: ['New'], dropped: [] }); });
    const sync = createSync(() => answered, channel, LABELS);

    void sync.run({});
    const settled = sync.settled();
    answer();
    await settled;

    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('New'));
  });
});

describe('createSync: outcome handling', () => {
  it('logs the lines it added and dropped, one Output line each way, under its prefix and labels', async () => {
    const { channel, run } = syncAnswering(() => Promise.resolve<Outcome>({ applied: true, added: ['New'], dropped: ['Gone'] }));
    await run();

    expect(channel.info).toHaveBeenCalledTimes(2);
    expect(channel.info).toHaveBeenCalledWith('[tidy] tidy added 1 order.txt line(s) added: New');
    expect(channel.info).toHaveBeenCalledWith('[tidy] tidy dropped 1 order.txt line(s) dropped: Gone');
    expect(channel.error).not.toHaveBeenCalled();
  });

  it('logs nothing when the file already agrees', async () => {
    const { channel, run } = syncAnswering(landed);
    await run();

    expect(channel.info).not.toHaveBeenCalled();
    expect(channel.error).not.toHaveBeenCalled();
  });

  it('says the command\'s own refusal in the Output and the message line', async () => {
    const { channel, sync, messageChanged, run } = syncAnswering(refused('the folder is gone'));
    await run();

    expect(channel.error).toHaveBeenCalledWith('[tidy] tidy failed: the folder is gone');
    expect(sync.message()).toBe('order.txt is not synced: the folder is gone.');
    expect(messageChanged).toHaveBeenCalledTimes(1);
  });

  it('says a thrown sync error the same way', async () => {
    const { channel, sync, run } = syncAnswering(() => Promise.reject(new Error('disk unplugged')));
    await run();

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('disk unplugged'));
    expect(sync.message()).toContain('disk unplugged');
  });

  it('reports the same refusal once, however many runs repeat it', async () => {
    const { channel, messageChanged, run } = syncAnswering(refused('gone'), refused('gone'), refused('gone'));
    await run();
    await run();
    await run();

    expect(channel.error).toHaveBeenCalledTimes(1);
    expect(messageChanged).toHaveBeenCalledTimes(1);
  });

  it('reports again when the reason changes', async () => {
    const { channel, sync, messageChanged, run } = syncAnswering(refused('first cause'), refused('second cause'));
    await run();
    await run();

    expect(channel.error).toHaveBeenCalledTimes(2);
    expect(channel.error).toHaveBeenLastCalledWith(expect.stringContaining('second cause'));
    expect(sync.message()).toContain('second cause');
    expect(messageChanged).toHaveBeenCalledTimes(2);
  });

  it('clears the message line when a run next lands, and reports a recurrence again', async () => {
    const { channel, sync, messageChanged, run } = syncAnswering(refused('gone'), landed, refused('gone'));
    await run();
    await run();

    expect(sync.message()).toBeUndefined();
    expect(messageChanged).toHaveBeenCalledTimes(2);

    await run();
    expect(channel.error).toHaveBeenCalledTimes(2);
    expect(sync.message()).toContain('gone');
  });

  it('the latest run decides the message line, whichever run answers last', async () => {
    let answerOlder!: (outcome: Outcome) => void;
    const older = new Promise<Outcome>((resolve) => { answerOlder = resolve; });
    const { sync, run } = syncAnswering(() => older, refused('gone'));
    const newerSaid = new Promise<void>((resolve) => {
      const listening = sync.onMessageChanged(() => { listening.dispose(); resolve(); });
    });
    const olderRun = run();
    const newerRun = run();
    await newerSaid;
    answerOlder({ applied: true, added: [], dropped: [] });
    await Promise.all([olderRun, newerRun]);

    expect(sync.message()).toContain('gone');
  });

  it('a landed run with no failure before it leaves the message line alone', async () => {
    const { sync, messageChanged, run } = syncAnswering(landed);
    await run();

    expect(sync.message()).toBeUndefined();
    expect(messageChanged).not.toHaveBeenCalled();
  });
});

describe('createSync: a refusal the instance\'s state already tells', () => {
  it('reports nothing of its own: no Output line and no message line', async () => {
    const { channel, sync, messageChanged, run } = syncAnswering(toldAsInstanceState);
    await run();

    expect(channel.error).not.toHaveBeenCalled();
    expect(channel.info).not.toHaveBeenCalled();
    expect(sync.message()).toBeUndefined();
    expect(messageChanged).not.toHaveBeenCalled();
  });

  it('takes its own standing refusal off the message line', async () => {
    const { sync, run } = syncAnswering(refused('plugins.txt cannot be written: EACCES'), toldAsInstanceState);
    await run();

    await run();

    expect(sync.message()).toBeUndefined();
  });
});
