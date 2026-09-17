import { describe, it, expect } from 'vitest';
import { loadOrderAppDataFolder } from '../loadOrderDestination';

describe('loadOrderAppDataFolder', () => {
  it('answers Fallout 4\'s AppData folder', () => {
    expect(loadOrderAppDataFolder('Fallout4')).toBe('Fallout4');
  });

  it('answers undefined for a release the table holds no row for', () => {
    expect(loadOrderAppDataFolder('SkyrimSE')).toBeUndefined();
  });
});
