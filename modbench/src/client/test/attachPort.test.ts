import { describe, it, expect } from 'vitest';
import { attachPortOf } from '../attachPort';

describe('the port to attach to', () => {
  it('is the number the setting holds, read by the key attachToBackendPort', () => {
    const keys: string[] = [];

    expect([attachPortOf((key) => { keys.push(key); return 5172; }), keys]).toEqual([5172, ['attachToBackendPort']]);
  });

  it.each([[null], [undefined], ['5172']])('is none when the setting holds %j, so the window starts its own', (held) => {
    expect(attachPortOf(() => held)).toBeUndefined();
  });
});
