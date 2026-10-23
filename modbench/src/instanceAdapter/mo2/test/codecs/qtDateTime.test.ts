import { describe, it, expect } from 'vitest';
import { localDateTimeStream } from '../../codecs/qtDateTime';
import { setIniDateTime } from '../../codecs/qSettingsIni';

describe('a QDateTime as MO2 stores it in a .meta', () => {
  const MO2_WROTE = '[General]\nfileTime="@DateTime(\\0\\0\\0\\x10\\0\\0\\0\\0\\0\\0%=\\x9c\\x4T\\xe5\\xf9\\0)"\n';

  it('writes the value MO2 wrote in UTC for the upload count 1455072761 (a real .meta of LitR)', () => {
    expect(setIniDateTime('[General]\n', 'General', 'fileTime', localDateTimeStream(1_455_072_761, 0))).toBe(MO2_WROTE);
  });

  it('writes the value MO2 writes for no time at all, unquoted', () => {
    const none = Buffer.from([0, 0, 0, 0x10, 0, 0x80, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0]);

    expect(setIniDateTime('[General]\n', 'General', 'fileTime', none)).toBe('[General]\nfileTime=@DateTime(\\0\\0\\0\\x10\\0\\x80\\0\\0\\0\\0\\0\\0\\0\\xff\\xff\\xff\\xff\\0)\n');
  });

  it('writes the local time of a zone ahead of UTC', () => {
    const utc = localDateTimeStream(1_455_072_761, 0);
    const ahead = localDateTimeStream(1_455_072_761, 60);

    expect(ahead.readUInt32BE(13) - utc.readUInt32BE(13)).toBe(3_600_000);
  });

  it('carries a local time past midnight into the next Julian day', () => {
    const stream = localDateTimeStream(86_400_000 - 1, 1);

    expect([Number(stream.readBigInt64BE(5)), stream.readUInt32BE(13)]).toEqual([2_440_589, 59_999]);
  });
});
