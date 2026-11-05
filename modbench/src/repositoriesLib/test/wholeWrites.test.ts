import { describe, it, expect, afterEach, vi } from 'vitest';
import { renameOver } from '../wholeWrites';

const heldOpen = (refusals: number) => {
  let refused = 0;
  return vi.fn((from: string, to: string): Promise<void> => (refused++ < refusals
    ? Promise.reject(Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' }))
    : Promise.resolve()));
};

describe('a rename onto a file another program holds open', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lands on Windows once the other program lets go', async () => {
    vi.useFakeTimers();
    const rename = heldOpen(3);

    const landed = renameOver(rename, 'temp', 'target', 'win32');
    await vi.runAllTimersAsync();
    await landed;

    expect(rename).toHaveBeenCalledTimes(4);
  });

  it('fails on Windows naming the target when the other program never lets go', async () => {
    vi.useFakeTimers();
    const failed = expect(renameOver(heldOpen(Infinity), 'temp', 'target', 'win32')).rejects.toThrow("-> 'target'");

    await vi.runAllTimersAsync();

    await failed;
  });

  it('fails at once on Linux, where a refused rename is a refusal', async () => {
    const rename = heldOpen(1);

    await expect(renameOver(rename, 'temp', 'target', 'linux')).rejects.toMatchObject({ code: 'EPERM' });
    expect(rename).toHaveBeenCalledTimes(1);
  });
});
