import { describe, it, expect } from 'vitest';
import { headerFormKeyOf, headerPluginNameOf } from '../headerFormKey';

describe('a Plugin Header record\'s FormKey, as mEdit indexes it', () => {
  it('is the null form in the plugin\'s file', () => {
    expect(headerFormKeyOf({ name: 'MyPatch.esp', origin: 'ModA' })).toBe('000000:MyPatch.esp');
  });

  it('names its plugin\'s file', () => {
    expect(headerPluginNameOf('000000:MyPatch.esp')).toBe('MyPatch.esp');
  });

  it('is no other record\'s FormKey', () => {
    expect(headerPluginNameOf('000800:MyPatch.esp')).toBeUndefined();
  });
});
