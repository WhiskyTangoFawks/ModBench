import { describe, it, expect, vi } from 'vitest';
import { declaredSetting, onSettingChange } from '../setting';

describe('onSettingChange', () => {
  it('signals for its setting and for no other', () => {
    let hear: (change: { affectsConfiguration(section: string): boolean }) => void = () => undefined;
    const listener = vi.fn();
    onSettingChange((l) => { hear = l; return { dispose: () => undefined }; }, 'modbench.a', listener);

    hear({ affectsConfiguration: (section) => section === 'modbench.b' });
    expect(listener).not.toHaveBeenCalled();

    hear({ affectsConfiguration: (section) => section === 'modbench.a' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('declaredSetting', () => {
  it('answers the value the manifest declared', () => {
    expect(declaredSetting('modbench.a', 'English')).toBe('English');
  });

  it('fails loudly when the setting has no value, rather than inventing a default the manifest owns', () => {
    expect(() => declaredSetting('modbench.a', undefined)).toThrow('modbench.a has no value');
  });
});
