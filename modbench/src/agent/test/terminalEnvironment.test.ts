import { delimiter } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';

type ConfigListener = (change: { affectsConfiguration(section: string): boolean }) => void;
let configListener: ConfigListener | undefined;
let terminalSettings: Record<string, Record<string, string | null> | undefined> = {};

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: (key: string) => terminalSettings[key] }),
    onDidChangeConfiguration: (listener: ConfigListener) => {
      configListener = listener;
      return { dispose: () => { configListener = undefined; } };
    },
  },
}));

import { inheritedPythonPath, onTerminalEnvChange, reachMEditFromTerminals } from '../terminalEnvironment';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

function fakeCollection() {
  const entries = new Map<string, { how: 'replace'; value: string }>();
  const collection = {
    persistent: true,
    replace: (variable: string, value: string) => { entries.set(variable, { how: 'replace', value }); },
    clear: () => { entries.clear(); },
  };
  return { collection, entries };
}

const noWatch = () => ({ dispose: () => undefined });

describe('reachMEditFromTerminals', () => {
  it('replaces PYTHONPATH again when the setting it was composed from changes', () => {
    const { collection, entries } = fakeCollection();
    let inherited: string | undefined = '/first';
    let changed: () => void = () => undefined;
    reachMEditFromTerminals(collection, new InMemoryMEditClient(), '/ext/scripts', () => inherited, (listener) => { changed = listener; return noWatch(); });

    inherited = '/second';
    changed();

    expect(entries.get('PYTHONPATH')?.value).toBe(`/ext/scripts${delimiter}/second`);
  });

  it.each([[undefined, '/ext/scripts'], ['', '/ext/scripts'], ['/other', `/ext/scripts${delimiter}/other`]])(
    'hands a terminal inheriting PYTHONPATH %j the scripts folder first and no empty entry, which Python reads as the working directory',
    (inherited, expected) => {
      const { collection, entries } = fakeCollection();

      reachMEditFromTerminals(collection, new InMemoryMEditClient(), '/ext/scripts', () => inherited, noWatch);

      expect(entries.get('PYTHONPATH')).toEqual({ how: 'replace', value: expected });
    },
  );

  it('hands a terminal this window\'s mEdit port once it is known, and the next one when it changes', () => {
    const { collection, entries } = fakeCollection();
    const client = new InMemoryMEditClient();
    reachMEditFromTerminals(collection, client, '/ext/scripts', () => undefined, noWatch);
    expect(entries.has('MEDIT_PORT')).toBe(false);

    client.claimedPort(41000);
    expect(entries.get('MEDIT_PORT')).toEqual({ how: 'replace', value: '41000' });

    client.claimedPort(41001);
    expect(entries.get('MEDIT_PORT')?.value).toBe('41001');
  });

  it('is not persisted, so a terminal VS Code restores never holds the last session\'s port', () => {
    const { collection } = fakeCollection();

    reachMEditFromTerminals(collection, new InMemoryMEditClient(), '/ext/scripts', () => undefined, noWatch);

    expect(collection.persistent).toBe(false);
  });

  it('hands nothing to a terminal once disposed', () => {
    const { collection, entries } = fakeCollection();
    const client = new InMemoryMEditClient();

    reachMEditFromTerminals(collection, client, '/ext/scripts', () => undefined, noWatch).dispose();
    client.claimedPort(41000);

    expect([...entries]).toEqual([]);
  });
});

describe('the terminal environment', () => {
  const platform = process.platform;
  const hostPythonPath = process.env.PYTHONPATH;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    process.env.PYTHONPATH = hostPythonPath;
    terminalSettings = {};
  });

  it.each([['linux', 'env.linux'], ['darwin', 'env.osx'], ['win32', 'env.windows']])(
    'gives %s terminals the PYTHONPATH the user sets for them, ahead of the extension host\'s own',
    (os, setting) => {
      Object.defineProperty(process, 'platform', { value: os });
      process.env.PYTHONPATH = '/host';
      terminalSettings = { [setting]: { PYTHONPATH: '/user' } };

      expect(inheritedPythonPath()).toBe('/user');
    },
  );

  it('gives terminals the extension host\'s own PYTHONPATH when the setting names none', () => {
    process.env.PYTHONPATH = '/host';
    terminalSettings = { 'env.linux': { OTHER: 'x' } };

    expect(inheritedPythonPath()).toBe('/host');
  });

  it('signals for this platform\'s terminal environment setting and for no other', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const listener = vi.fn();
    onTerminalEnvChange(listener);

    configListener?.({ affectsConfiguration: (s) => s === 'terminal.integrated.env.linux' });
    expect(listener).not.toHaveBeenCalled();

    configListener?.({ affectsConfiguration: (s) => s === 'terminal.integrated.env.windows' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
