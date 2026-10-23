// A local QDateTime as QDataStream writes it for a QVariant: type and null flag, the date as a Julian day,
// the time as milliseconds into the day, the time spec.

const QDATETIME_TYPE = 16;
const LOCAL_TIME = 0;
const UNIX_EPOCH_JULIAN_DAY = 2440588;
const DAY_MS = 86_400_000;

/** `QDateTime::fromMSecsSinceEpoch(milliseconds)` as MO2's QSettings stores it, for a zone `utcOffsetMinutes` ahead of UTC. */
export function localDateTimeStream(milliseconds: number, utcOffsetMinutes: number): Buffer {
  const local = milliseconds + utcOffsetMinutes * 60_000;
  const days = Math.floor(local / DAY_MS);
  const stream = Buffer.alloc(18);
  stream.writeUInt32BE(QDATETIME_TYPE, 0);
  stream.writeBigInt64BE(BigInt(days + UNIX_EPOCH_JULIAN_DAY), 5);
  stream.writeUInt32BE(local - days * DAY_MS, 13);
  stream.writeInt8(LOCAL_TIME, 17);
  return stream;
}
