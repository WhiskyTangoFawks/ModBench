import { describe, it, expect, vi } from 'vitest';
import { onSettingChange } from '../setting';

describe('a change to a setting', () => {
  it('signals for its setting and for no other', () => {
    let hear: (change: { affectsConfiguration(section: string): boolean }) => void = () => undefined;
    const listener = vi.fn();
    onSettingChange((l) => { hear = l; return { dispose: () => undefined }; }, 'modbench.a', listener);

    hear({ affectsConfiguration: (section) => section === 'modbench.b' });
    expect(listener).not.toHaveBeenCalled();

    hear({ affectsConfiguration: (section) => section === 'modbench.a' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('signals for any of several settings', () => {
    let hear: (change: { affectsConfiguration(section: string): boolean }) => void = () => undefined;
    const listener = vi.fn();
    onSettingChange((l) => { hear = l; return { dispose: () => undefined }; }, ['modbench.a', 'modbench.b'], listener);

    hear({ affectsConfiguration: (section) => section === 'modbench.b' });

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
