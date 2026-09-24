import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tsFiles } from './tsFiles';
import { FakeInstance } from './mo2/fakeInstance';
import { instanceValueFixture } from './mo2/instanceValueFixture';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn() }));
vi.mock('vscode', () => ({ commands: { executeCommand }, workspace: {} }));

import { answerInstanceCheck, markFirstReadLanded } from '../workspaceConfig';
import { FOLDER_KEY, INSTANCE_READ_KEY } from '../folderContext';

const writesOfTheKey = () => executeCommand.mock.calls.filter(([command, key]) => command === 'setContext' && key === FOLDER_KEY);

beforeEach(() => executeCommand.mockClear());

describe('the instance check', () => {
  it('answers not an instance with no folder open, without asking the mod manager', () => {
    const isInstance = vi.fn(() => true);
    expect(answerInstanceCheck(undefined, isInstance)).toBe('notAnInstance');
    expect(isInstance).not.toHaveBeenCalled();
    expect(writesOfTheKey()).toEqual([['setContext', FOLDER_KEY, 'notAnInstance']]);
  });

  it('answers not an instance for a folder the mod manager does not recognize', () => {
    expect(answerInstanceCheck('/some/folder', () => false)).toBe('notAnInstance');
    expect(writesOfTheKey()).toEqual([['setContext', FOLDER_KEY, 'notAnInstance']]);
  });

  it('answers instance for a folder the mod manager recognizes', () => {
    const isInstance = vi.fn(() => true);
    expect(answerInstanceCheck('/instance', isInstance)).toBe('instance');
    expect(isInstance).toHaveBeenCalledWith('/instance');
    expect(writesOfTheKey()).toEqual([['setContext', FOLDER_KEY, 'instance']]);
  });
});

const writesOfTheReadKey = () =>
  executeCommand.mock.calls.filter(([command, key]) => command === 'setContext' && key === INSTANCE_READ_KEY);

describe("the instance's first read", () => {
  const unread = () => new FakeInstance(instanceValueFixture(), 0);

  it('leaves the key unset until a value lands', () => {
    const mark = markFirstReadLanded(unread());
    expect(writesOfTheReadKey()).toEqual([]);
    expect(mark.landed).toBe(false);
  });

  it('leaves the key unset through a failed read, and sets it when the next read lands', () => {
    const instance = unread();
    const mark = markFirstReadLanded(instance);
    instance.fail('ModOrganizer.ini is empty');
    expect(writesOfTheReadKey()).toEqual([]);
    expect(mark.landed).toBe(false);
    instance.publish(instanceValueFixture());
    expect(writesOfTheReadKey()).toEqual([['setContext', INSTANCE_READ_KEY, true]]);
    expect(mark.landed).toBe(true);
  });

  it('sets the key once the first value lands, and never again', () => {
    const instance = unread();
    markFirstReadLanded(instance);
    instance.publish(instanceValueFixture());
    instance.publish(instanceValueFixture());
    expect(writesOfTheReadKey()).toEqual([['setContext', INSTANCE_READ_KEY, true]]);
  });

  it('stops listening when disposed before any value lands', () => {
    const instance = unread();
    markFirstReadLanded(instance).dispose();
    instance.publish(instanceValueFixture());
    expect(writesOfTheReadKey()).toEqual([]);
  });
});

// A second writer, such as a default set at activation, would make a key read as answered
// before its fact is known.
describe('each key has one writer', () => {
  const SRC = join(__dirname, '..');
  const OWNERS = ['folderContext.ts', 'workspaceConfig.ts'];
  const production = tsFiles(SRC, { exclude: ['generated', 'test'] });
  const naming = (pattern: RegExp) =>
    production.filter((path) => pattern.test(readFileSync(path, 'utf8'))).map((path) => relative(SRC, path));

  it('scans a real body of files', () => {
    expect(production.length).toBeGreaterThan(100);
  });

  it('names the folder key only where it is declared and written', () => {
    expect(naming(/\bFOLDER_KEY\b|modbench\.folder\b/).sort()).toEqual(OWNERS);
  });

  it('names the first-read key only where it is declared and written', () => {
    expect(naming(/\bINSTANCE_READ_KEY\b|modbench\.instanceRead\b/).sort()).toEqual(OWNERS);
  });

  it('marks the first read from the one place the Instance is built', () => {
    expect(naming(/\bmarkFirstReadLanded\(/).sort()).toEqual(['toolbox.ts', 'workspaceConfig.ts']);
  });
});
