import { describe, expect, it } from 'vitest';
import { pluginSourceNames } from '../pluginSourceNames';
import type { DocumentName } from '../MEditClient';
import { InMemoryMEditClient } from './InMemoryMEditClient';
import { localFailure } from '../../wire/readFailed';

const SOURCE = '/instance/source/Mod/plugin-source/Mod.esp/Npc.json';
const README = '/instance/README.md';
const TEXT = '{ "FormKey": "000801:Mod.esp" }';
const NAMED: DocumentName[] = [{ kind: 'Record', start: 13, end: 29, value: '000801:Mod.esp', record: '000801:Mod.esp', fieldPath: 'FormKey' }];

function asking() {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPluginSourceNames', NAMED);
  const names = pluginSourceNames(client, (path) => path === SOURCE);
  const asked = () => client.calls.filter(({ method }) => method === 'getPluginSourceNames').map(({ args }) => args);
  return { names, client, asked };
}

describe('asking the record index what plugin source names (target-architecture.md)', () => {
  it('names nothing in a file that is no plugin source, asking mEdit nothing', async () => {
    const { names, asked } = asking();

    expect([await names.getPluginSourceNames(TEXT, README, 3), asked()]).toEqual([[], []]);
  });

  it.each([
    ['a place in plugin source', SOURCE, 3],
    ['a copy\'s document, by its text alone', undefined, undefined],
  ])('asks mEdit once of %s, however many kinds ask', async (_case, path, at) => {
    const { names, asked } = asking();

    const answers = [await names.getPluginSourceNames(TEXT, path, at), await names.getPluginSourceNames(TEXT, path, at)];

    expect([answers, asked()]).toEqual([[NAMED, NAMED], [[TEXT, path, at]]]);
  });

  const mod = { name: 'Mod.esp', origin: 'Mod' };
  it.each([
    ['rows', [{ plugin: mod, keys: [] }]],
    ['a plugin', [{ plugin: mod }]],
    ['everything', undefined],
  ])('asks again once the change event names %s', async (_what, change) => {
    const { names, client, asked } = asking();

    await names.getPluginSourceNames(TEXT, SOURCE, 3);
    client.change(change);
    await names.getPluginSourceNames(TEXT, SOURCE, 3);

    expect(asked()).toHaveLength(2);
  });

  it('asks again where mEdit could not answer', async () => {
    const { names, client, asked } = asking();
    client.setQueryFailure('getPluginSourceNames', localFailure('mEdit is indexing'));

    await names.getPluginSourceNames(TEXT, SOURCE, 3);
    await names.getPluginSourceNames(TEXT, SOURCE, 3);

    expect(asked()).toHaveLength(2);
  });
});
