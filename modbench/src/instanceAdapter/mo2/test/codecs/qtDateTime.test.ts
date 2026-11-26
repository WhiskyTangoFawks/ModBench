import { describe, it, expect, vi, afterEach } from 'vitest';
import { fakeVscodeModule } from '../../../../test/mo2/fakeVscodeWatcher';
import { mo2InstanceHolding } from '../../../test/mo2InstanceHolding';

vi.mock('vscode', () => fakeVscodeModule());

const NAME = 'Release.7z';

describe('a QDateTime as MO2 stores it in a .meta', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    ['writes the value MO2 wrote in UTC for the upload count 1455072761 (a real .meta of LitR)', 1_455_072_761, 0,
      'fileTime="@DateTime(\\0\\0\\0\\x10\\0\\0\\0\\0\\0\\0%=\\x9c\\x4T\\xe5\\xf9\\0)"'],
    ['writes a time whose bytes hold no comma, semicolon or equals sign unquoted', 1_455_072_761_000, 0,
      'fileTime=@DateTime(\\0\\0\\0\\x10\\0\\0\\0\\0\\0\\0%\\x7fU\\0\\x9e\\x18\\xa8\\0)'],
    ['writes the local time of a zone ahead of UTC', 1_455_072_761_000, 60,
      'fileTime=@DateTime(\\0\\0\\0\\x10\\0\\0\\0\\0\\0\\0%\\x7fU\\0\\xd5\\a(\\0)'],
    ['carries a local time past midnight into the next Julian day', 86_400_000 - 1, 1,
      'fileTime="@DateTime(\\0\\0\\0\\x10\\0\\0\\0\\0\\0\\0%=\\x8d\\0\\0\\xea_\\0)"'],
  ])('%s', async (_, fileTime, minutesAheadOfUtc, line) => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-minutesAheadOfUtc);
    const { adapter, text } = mo2InstanceHolding({ [`downloads/${NAME}`]: 'bytes' });

    await adapter.writeNexusFileInfo(NAME, { game: 'fallout4', modID: '1', fileTime });

    expect((await text(`downloads/${NAME}.meta`)).split(/\r?\n/).find((written) => written.startsWith('fileTime='))).toBe(line);
  });
});
