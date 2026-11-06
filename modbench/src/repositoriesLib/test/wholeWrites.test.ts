import { describe, it, expect, afterEach, vi } from 'vitest';
import { renameOver } from '../wholeWrites';

const refusing = (code: string, refusals: number) => {
  let refused = 0;
  return vi.fn((from: string, to: string): Promise<void> => (refused++ < refusals
    ? Promise.reject(Object.assign(new Error(`${code}: rename '${from}' -> '${to}'`), { code }))
    : Promise.resolve()));
};

describe('a rename onto a file another program holds open', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([['EPERM', 4], ['EACCES', 4], ['EBUSY', 4], ['EIO', 1]])('on Windows, refused three times with %s, tries %i times in all', async (code, tries) => {
    vi.useFakeTimers();
    const rename = refusing(code, 3);

    const landed = renameOver(rename, 'temp', 'target', 'win32').catch(() => undefined);
    await vi.runAllTimersAsync();
    await landed;

    expect(rename).toHaveBeenCalledTimes(tries);
  });

  it('fails on Windows naming the target when the other program never lets go', async () => {
    vi.useFakeTimers();
    const failed = expect(renameOver(refusing('EPERM', Infinity), 'temp', 'target', 'win32')).rejects.toThrow("-> 'target'");

    await vi.runAllTimersAsync();

    await failed;
  });

  it('fails at once on Linux, where a refused rename is a refusal', async () => {
    const rename = refusing('EPERM', 1);

    await expect(renameOver(rename, 'temp', 'target', 'linux')).rejects.toMatchObject({ code: 'EPERM' });
    expect(rename).toHaveBeenCalledTimes(1);
  });
});
