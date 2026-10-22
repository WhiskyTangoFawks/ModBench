// QString::toInt in base 10: surrounding whitespace allowed, a sign allowed, and anything else, or a value past 32 bits, is 0.

const INT_MAX = 2 ** 31 - 1;
const INT_MIN = -(2 ** 31);

export function qtToInt(text: string): number {
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return 0;
  const value = Number(trimmed);
  return value >= INT_MIN && value <= INT_MAX ? value : 0;
}
