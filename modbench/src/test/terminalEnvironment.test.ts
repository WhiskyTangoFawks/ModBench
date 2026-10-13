import { delimiter } from 'node:path';
import { describe, it, expect } from 'vitest';
import { reachMEditFromTerminals } from '../terminalEnvironment';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';

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
