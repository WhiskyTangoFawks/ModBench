import { describe, it, expect, vi } from 'vitest';

type ConfigListener = (change: { affectsConfiguration(section: string): boolean }) => void;
let language: string | undefined;
let configListener: ConfigListener | undefined;
const commands = new Map<string, (value: unknown) => void>();

vi.mock('vscode', () => ({
  Disposable: { from: (...parts: { dispose(): void }[]) => ({ dispose: () => { parts.forEach((part) => { part.dispose(); }); } }) },
  workspace: {
    getConfiguration: () => ({ get: () => language }),
    onDidChangeConfiguration: (listener: ConfigListener) => { configListener = listener; return { dispose: () => undefined }; },
  },
  commands: {
    registerCommand: (id: string, handler: (value: unknown) => void) => { commands.set(id, handler); return { dispose: () => undefined }; },
  },
}));

import { toldOf } from '../../instanceLoader/told';
import { registerPutLoadOrder } from '../putLoadOrderCommand';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import type { InstanceSubscriber } from '../../instanceLoader/instance';
import { settled as until } from '../../test/eventually';

const wired = () => {
  const puts: (string | undefined)[] = [];
  const sent: string[] = [];
  const instance = new FakeInstance(instanceValueFixture());
  registerPutLoadOrder({
    onRecompute: (_source, stringsLanguage) => { puts.push(stringsLanguage); sent.push('put'); },
    signalChange: (paths) => { sent.push(`signal ${paths.join()}`); return Promise.resolve(); },
  }, instance);
  return { puts, sent, instance };
};

describe('signal change', () => {
  it('follows the put at every recompute, naming the paths it read again, and none for a check of the disk', () => {
    const { sent, instance } = wired();

    instance.publish(instanceValueFixture(), { named: ['/mods/A/A.esp', '/mods/B/B.esp'], disk: false });
    instance.publish(instanceValueFixture(), { named: ['/mods/A/A.esp'], disk: true });

    expect(sent).toEqual(['put', 'signal /mods/A/A.esp,/mods/B/B.esp', 'put', 'signal ']);
  });

  it('is not sent for a recompute that named no path and was not a check of the disk', () => {
    const { sent, instance } = wired();

    instance.publish(instanceValueFixture(), { named: [], disk: false });

    expect(sent).toEqual(['put']);
  });

  it('is not sent for a change of the strings language, which changes no file', () => {
    const { sent } = wired();

    configListener?.({ affectsConfiguration: (section) => section === 'modbench.stringsLanguage' });

    expect(sent).toEqual(['put']);
  });

  it('is the command modbench.instance.signalChange', () => {
    const { sent } = wired();

    commands.get('modbench.instance.signalChange')?.(undefined);

    expect(sent).toEqual(['signal ']);
  });
});

describe('the instance read that signalled', () => {
  it('settles once the sweep the signal started has settled', async () => {
    let sweepEnds!: () => void;
    const sweep = new Promise<void>((resolve) => { sweepEnds = resolve; });
    const subscribers: InstanceSubscriber[] = [];
    registerPutLoadOrder(
      { onRecompute: () => undefined, signalChange: () => sweep },
      { value: instanceValueFixture(), subscribe: (subscriber) => { subscribers.push(subscriber); return { dispose: () => undefined }; } },
    );
    const signalling = subscribers.at(-1);
    let settled = false;

    void Promise.resolve(signalling?.(instanceValueFixture(), 1, toldOf(instanceValueFixture(), instanceValueFixture(), { named: [], disk: true }, undefined))).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    sweepEnds();
    await until(() => { expect(settled).toBe(true); });
  });
});

describe('put load order', () => {
  it('puts with the strings language the setting holds when the put is made', () => {
    const { puts, instance } = wired();
    language = 'English';
    instance.publish(instanceValueFixture());
    language = 'French';
    instance.publish(instanceValueFixture());

    expect(puts).toEqual(['English', 'French']);
  });

  it('puts the current value once for each change of the strings language, and none before one', () => {
    const { puts } = wired();
    language = 'German';
    expect(puts).toEqual([]);

    configListener?.({ affectsConfiguration: (section) => section === 'modbench.stringsLanguage' });

    expect(puts).toEqual(['German']);
  });

  it('is the command modbench.instance.putLoadOrder', () => {
    const { puts } = wired();
    language = 'Spanish';

    commands.get('modbench.instance.putLoadOrder')?.(instanceValueFixture());

    expect(puts).toEqual(['Spanish']);
  });
});
