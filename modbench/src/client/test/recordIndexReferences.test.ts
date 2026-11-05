import { describe, expect, it } from 'vitest';
import { recordIndexReferences } from '../recordIndexReferences';

const symbol = { name: 'Base.esm', origin: 'BaseMod' };
const child = { name: 'Child.esp', origin: 'ChildMod' };

describe('the record index says where plugins name a plugin (ADR-0028)', () => {
  it('answers each copy that names the plugin, named by its file name alone', async () => {
    const owner = recordIndexReferences({ getPluginNameReferences: () => Promise.resolve([{ formKey: '000800:Base.esm', plugin: child, documentText: null }]) });

    expect(await owner.read(symbol, new Map())).toEqual({
      references: [{ copy: { formKey: '000800:Base.esm', plugin: child }, names: { name: 'Base.esm' } }], leftOut: [],
    });
  });

  it('leaves out every plugin, saying why, when mEdit cannot answer', async () => {
    const owner = recordIndexReferences({ getPluginNameReferences: () => Promise.resolve({ failed: 'refused', refusal: 'mEdit is still indexing plugins.' }) });

    expect(await owner.read(symbol, new Map())).toEqual({ references: [], leftOut: ['the plugins mEdit reads: mEdit is still indexing plugins.'] });
  });
});
