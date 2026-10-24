import { delimiter } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

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

import { reachMEditFromTerminals } from '../terminalEnvironment';
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

const SCRIPTS = '/ext/scripts';
const changeTo = (section: string): void => configListener?.({ affectsConfiguration: (s) => s === section });

function pythonPathOf(): string | undefined {
  const { collection, entries } = fakeCollection();
  reachMEditFromTerminals(collection, new InMemoryMEditClient(), SCRIPTS);
  return entries.get('PYTHONPATH')?.value;
}

describe('what a terminal of this window is handed to reach mEdit', () => {
  const platform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    vi.unstubAllEnvs();
    terminalSettings = {};
  });

  it('replaces PYTHONPATH again when the terminal environment setting it was composed from changes', () => {
    const { collection, entries } = fakeCollection();
    terminalSettings = { 'env.linux': { PYTHONPATH: '/first' } };
    reachMEditFromTerminals(collection, new InMemoryMEditClient(), SCRIPTS);

    terminalSettings = { 'env.linux': { PYTHONPATH: '/second' } };
    changeTo('terminal.integrated.env.linux');

    expect(entries.get('PYTHONPATH')?.value).toBe(`${SCRIPTS}${delimiter}/second`);
  });

  it.each([[undefined, SCRIPTS], ['', SCRIPTS], ['/other', `${SCRIPTS}${delimiter}/other`]])(
    'hands a terminal inheriting PYTHONPATH %j the scripts folder first and no empty entry, which Python reads as the working directory',
    (inherited, expected) => {
      vi.stubEnv('PYTHONPATH', inherited);

      expect(pythonPathOf()).toBe(expected);
    },
  );

  it.each([['linux', 'env.linux'], ['darwin', 'env.osx'], ['win32', 'env.windows']])(
    'gives %s terminals the PYTHONPATH the user sets for them, ahead of the extension host\'s own',
    (os, setting) => {
      Object.defineProperty(process, 'platform', { value: os });
      vi.stubEnv('PYTHONPATH', '/host');
      terminalSettings = { [setting]: { PYTHONPATH: '/user' } };

      expect(pythonPathOf()).toBe(`${SCRIPTS}${delimiter}/user`);
    },
  );

  it('gives terminals the extension host\'s own PYTHONPATH when the setting names none', () => {
    vi.stubEnv('PYTHONPATH', '/host');
    terminalSettings = { 'env.linux': { OTHER: 'x' } };

    expect(pythonPathOf()).toBe(`${SCRIPTS}${delimiter}/host`);
  });

  it('recomposes for this platform\'s terminal environment setting and for no other', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { collection, entries } = fakeCollection();
    reachMEditFromTerminals(collection, new InMemoryMEditClient(), SCRIPTS);
    terminalSettings = { 'env.windows': { PYTHONPATH: '/win' }, 'env.linux': { PYTHONPATH: '/lin' } };

    changeTo('terminal.integrated.env.linux');
    expect(entries.get('PYTHONPATH')?.value).not.toContain('/win');

    changeTo('terminal.integrated.env.windows');
    expect(entries.get('PYTHONPATH')?.value).toBe(`${SCRIPTS}${delimiter}/win`);
  });

  it('hands a terminal this window\'s mEdit port once it is known, and the next one when it changes', () => {
    const { collection, entries } = fakeCollection();
    const client = new InMemoryMEditClient();
    reachMEditFromTerminals(collection, client, SCRIPTS);
    expect(entries.has('MEDIT_PORT')).toBe(false);

    client.claimedPort(41000);
    expect(entries.get('MEDIT_PORT')).toEqual({ how: 'replace', value: '41000' });

    client.claimedPort(41001);
    expect(entries.get('MEDIT_PORT')?.value).toBe('41001');
  });

  it('is not persisted, so a terminal VS Code restores never holds the last session\'s port', () => {
    const { collection } = fakeCollection();

    reachMEditFromTerminals(collection, new InMemoryMEditClient(), SCRIPTS);

    expect(collection.persistent).toBe(false);
  });

  it('hands nothing to a terminal once disposed', () => {
    const { collection, entries } = fakeCollection();
    const client = new InMemoryMEditClient();

    reachMEditFromTerminals(collection, client, SCRIPTS).dispose();
    client.claimedPort(41000);

    expect([...entries]).toEqual([]);
  });
});
