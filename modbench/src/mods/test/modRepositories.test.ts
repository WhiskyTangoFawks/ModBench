import { describe, it, expect, vi, beforeEach } from 'vitest';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { FakeInstance } from '../../test/mo2/fakeInstance';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn() }));
vi.mock('vscode', () => ({ commands: { executeCommand } }));

import { showModRepositories } from '../modRepositories';

beforeEach(() => executeCommand.mockClear());

describe('the lists published as context keys', () => {
  const tracked = () => instanceValueFixture({
    mods: [{ kind: 'mod', name: 'Tracked', enabled: true }],
    trackedMods: new Set(['Tracked']),
    plugins: [{ name: 'A.esp', origin: 'Tracked', path: '/instance/mods/Tracked/A.esp', slot: 0, enabled: true, winning: true }],
  });

  it('sets both keys at once and again on each new value', () => {
    const instance = new FakeInstance(tracked());
    showModRepositories(instance);
    expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.mod.tracked', ['Tracked']);
    expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.mod.untracked', []);
    executeCommand.mockClear();
    instance.publish(instanceValueFixture());
    expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.mod.tracked', []);
  });

  it('stops setting them once disposed', () => {
    const instance = new FakeInstance(tracked());
    showModRepositories(instance).dispose();
    executeCommand.mockClear();
    instance.publish(tracked());
    expect(executeCommand).not.toHaveBeenCalled();
  });
});

const pluginIn = (origin: string, name: string) => ({ name, origin, path: `/instance/mods/${origin}/${name}`, slot: 0, enabled: true, winning: true });

describe('which plugin origins have a repository, for the column header', () => {
  const published = (value: ReturnType<typeof instanceValueFixture>) => {
    showModRepositories(new FakeInstance(value));
    return Object.fromEntries(executeCommand.mock.calls.map(([, key, origins]) => [String(key), origins]));
  };

  it('names each origin by whether its mod has one, and no origin that is not a mod', () => {
    expect(published(instanceValueFixture({
      mods: [
        { kind: 'mod', name: 'Tracked', enabled: true },
        { kind: 'separator', name: 'Group', enabled: true },
        { kind: 'mod', name: 'Untracked', enabled: false },
      ],
      trackedMods: new Set(['Tracked']),
      plugins: [pluginIn('Tracked', 'A.esp'), pluginIn('Tracked', 'B.esp'), pluginIn('Untracked', 'C.esp'), pluginIn('overwrite', 'D.esp')],
    }))).toEqual({ 'modbench.mod.tracked': ['Tracked'], 'modbench.mod.untracked': ['Untracked'] });
  });

  it('carries the origin as the plugins spell it when it differs in case from the mod', () => {
    expect(published(instanceValueFixture({
      mods: [{ kind: 'mod', name: 'Harder VATS', enabled: true }, { kind: 'mod', name: 'Other', enabled: true }],
      trackedMods: new Set(['Harder VATS']),
      plugins: [pluginIn('harder vats', 'A.esp'), pluginIn('OTHER', 'B.esp')],
    }))).toEqual({ 'modbench.mod.tracked': ['harder vats'], 'modbench.mod.untracked': ['OTHER'] });
  });
});
