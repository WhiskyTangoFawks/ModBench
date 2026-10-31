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

import { registerPutLoadOrder } from '../putLoadOrderCommand';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { FakeInstance } from '../../test/mo2/fakeInstance';

const wired = () => {
  const puts: (string | undefined)[] = [];
  const instance = new FakeInstance(instanceValueFixture());
  registerPutLoadOrder({ onRecompute: (_source, stringsLanguage) => { puts.push(stringsLanguage); } }, instance);
  return { puts, instance };
};

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
