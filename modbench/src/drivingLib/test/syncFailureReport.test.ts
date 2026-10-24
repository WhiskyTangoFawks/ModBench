import { describe, it, expect } from 'vitest';
import { createModSync, createPluginSync, type SyncChannel } from '../syncFailureReport';
import { present } from '../../ports/present';
import { leveledLog } from '../../test/leveledLog';

type Outcome =
  | { applied: true; added: readonly string[]; dropped: readonly string[] }
  | { applied: false; refusal: string }
  | { applied: false; toldAsInstanceState: true };

function syncAnswering(...outcomes: (() => Promise<Outcome>)[]) {
  const channel = leveledLog();
  let calls = 0;
  const sync = createPluginSync(() => present(outcomes[calls++], 'an outcome for this run')(), channel);
  const messagesShown: (string | undefined)[] = [];
  sync.onMessageChanged(() => messagesShown.push(sync.message()));
  const run = async (): Promise<void> => {
    void sync.run();
    await sync.settled();
  };
  return { lines: channel.lines, messagesShown, sync, run };
}

const refused = (refusal: string) => () => Promise.resolve<Outcome>({ applied: false, refusal });
const landed = () => Promise.resolve<Outcome>({ applied: true, added: [], dropped: [] });
const toldAsInstanceState = () => Promise.resolve<Outcome>({ applied: false, toldAsInstanceState: true });

describe('a sync: settled', () => {
  it('resolves once every run begun has written its Output', async () => {
    const channel = leveledLog();
    let answer = (): void => {};
    const answered = new Promise<Outcome>((resolve) => { answer = () => resolve({ applied: true, added: ['New'], dropped: [] }); });
    const sync = createPluginSync(() => answered, channel);

    void sync.run();
    const settled = sync.settled();
    answer();
    await settled;

    expect(channel.lines.info).toEqual([
      '[pluginCommands] plugin sync added 1 disabled plugins.txt line(s) for plugin(s) provided with no line: New',
    ]);
  });

  it('resolves for a run whose Output write threw', async () => {
    const channel: SyncChannel = { error: () => undefined, info: () => { throw new Error('the Output is gone'); } };
    const sync = createPluginSync(() => Promise.resolve<Outcome>({ applied: true, added: ['New'], dropped: [] }), channel);

    const run = sync.run();

    await expect(sync.settled()).resolves.toBeUndefined();
    await expect(run).rejects.toThrow('the Output is gone');
  });
});

describe('a sync: outcome handling', () => {
  it('logs nothing when the file already agrees', async () => {
    const { lines, run } = syncAnswering(landed);
    await run();

    expect(lines).toEqual({ info: [], warn: [], error: [] });
  });

  it.each([
    ['the command\'s own refusal', refused('the folder is gone'),
      '[pluginCommands] plugin sync failed: the folder is gone', 'plugins.txt is not synced: the folder is gone.'],
    ['a thrown sync error', () => Promise.reject(new Error('disk unplugged')),
      '[pluginCommands] plugin sync failed: disk unplugged', 'plugins.txt is not synced: disk unplugged.'],
  ])('says %s in the Output and the message line', async (_case, answer, line, message) => {
    const { lines, messagesShown, run } = syncAnswering(answer);
    await run();

    expect({ lines, messagesShown }).toEqual({
      lines: { info: [], warn: [], error: [line] },
      messagesShown: [message],
    });
  });

  it('ends the message line with one full stop when the refusal already ends its sentence', async () => {
    const { sync, run } = syncAnswering(refused('mEdit could not be reached.'));
    await run();

    expect(sync.message()).toBe('plugins.txt is not synced: mEdit could not be reached.');
  });

  it('reports the same refusal once, however many runs repeat it', async () => {
    const { lines, messagesShown, run } = syncAnswering(refused('gone'), refused('gone'), refused('gone'));
    await run();
    await run();
    await run();

    expect({ errors: lines.error, messagesShown }).toEqual({
      errors: ['[pluginCommands] plugin sync failed: gone'],
      messagesShown: ['plugins.txt is not synced: gone.'],
    });
  });

  it('reports again when the reason changes', async () => {
    const { lines, messagesShown, run } = syncAnswering(refused('first cause'), refused('second cause'));
    await run();
    await run();

    expect({ errors: lines.error, messagesShown }).toEqual({
      errors: ['[pluginCommands] plugin sync failed: first cause', '[pluginCommands] plugin sync failed: second cause'],
      messagesShown: ['plugins.txt is not synced: first cause.', 'plugins.txt is not synced: second cause.'],
    });
  });

  it('clears the message line when a run next lands, and reports a recurrence again', async () => {
    const { lines, messagesShown, run } = syncAnswering(refused('gone'), landed, refused('gone'));
    await run();
    await run();
    await run();

    expect({ errors: lines.error, messagesShown }).toEqual({
      errors: ['[pluginCommands] plugin sync failed: gone', '[pluginCommands] plugin sync failed: gone'],
      messagesShown: ['plugins.txt is not synced: gone.', undefined, 'plugins.txt is not synced: gone.'],
    });
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

    expect(sync.message()).toBe('plugins.txt is not synced: gone.');
  });

  it('a landed run with no failure before it leaves the message line alone', async () => {
    const { messagesShown, run } = syncAnswering(landed);
    await run();

    expect(messagesShown).toEqual([]);
  });
});

describe('a sync: a refusal the instance\'s state already tells', () => {
  it('reports nothing of its own: no Output line and no message line', async () => {
    const { lines, messagesShown, run } = syncAnswering(toldAsInstanceState);
    await run();

    expect({ lines, messagesShown }).toEqual({ lines: { info: [], warn: [], error: [] }, messagesShown: [] });
  });

  it('takes its own standing refusal off the message line', async () => {
    const { sync, run } = syncAnswering(refused('plugins.txt cannot be written: EACCES'), toldAsInstanceState);
    await run();

    await run();

    expect(sync.message()).toBeUndefined();
  });
});

describe('the sync wording', () => {
  const addedAndDropped = () => Promise.resolve<Outcome>({ applied: true, added: ['A'], dropped: ['B'] });
  const refusing = () => Promise.resolve<Outcome>({ applied: false, refusal: 'locked' });
  const modSync = (run: () => Promise<Outcome>, channel: SyncChannel) => createModSync(run, channel, 'modlist.txt');

  it.each([
    {
      name: 'a mod sync names the mod manager\'s mod order file', create: modSync,
      lines: [
        '[modCommands] mod sync added 1 modlist.txt line(s) for folder(s) in mods/ with no line: A',
        '[modCommands] mod sync dropped 1 modlist.txt line(s) whose folder is gone from mods/: B',
      ],
      unsynced: 'modlist.txt is not synced: locked.',
    },
    {
      name: 'a plugin sync names plugins.txt', create: createPluginSync,
      lines: [
        '[pluginCommands] plugin sync added 1 disabled plugins.txt line(s) for plugin(s) provided with no line: A',
        '[pluginCommands] plugin sync dropped 1 plugins.txt line(s) that nothing provides: B',
      ],
      unsynced: 'plugins.txt is not synced: locked.',
    },
  ])('$name', async ({ create, lines, unsynced }) => {
    const channel = leveledLog();
    await create(addedAndDropped, channel).run();
    expect(channel.lines.info).toEqual(lines);

    const refused = create(refusing, channel);
    await refused.run();
    expect(refused.message()).toBe(unsynced);
  });
});
