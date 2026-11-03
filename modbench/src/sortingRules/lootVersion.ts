const PSEUDOSEM = String.raw`(\d+(?:\.\d+)+(?:[-._:]?[A-Za-z0-9]+)*)(?:[^,]|$)`;

// In LOOT's order of priority.
const VERSION_IN_DESCRIPTION = [
  /(\d{1,2}\/\d{1,2}\/\d{1,4} \d{1,2}:\d{1,2}:\d{1,2})/i,
  new RegExp(String.raw`version:?\s${PSEUDOSEM}`, 'i'),
  new RegExp(String.raw`(?:^|v|\s)${PSEUDOSEM}`, 'i'),
  /(?:^|v|version:\s*)(\d+)/i,
];

/** The version a plugin's description states, as LOOT reads it. */
export function versionInDescription(description: string): string | undefined {
  for (const pattern of VERSION_IN_DESCRIPTION) {
    const found = pattern.exec(description)?.[1]?.trim();
    if (found !== undefined) return found;
  }
  return undefined;
}

interface Version {
  release: string[];
  prerelease: string[];
}

function parse(text: string): Version {
  const clean = (/^\d+(, \d+){3}$/.test(text) ? text.replace(/, /g, '.') : text).split('+')[0] ?? '';
  const split = clean.search(/[-:_ ]/);
  const [release, prerelease] = split === -1 ? [clean, ''] : [clean.slice(0, split), clean.slice(split + 1)];
  return { release: release.split(/[.,]/), prerelease: prerelease === '' ? [] : prerelease.split(/[-.:_ ]/) };
}

const isNumber = (id: string): boolean => /^\d+$/.test(id);

const lexical = (a: string, b: string): number => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x === y) return 0;
  return x < y ? -1 : 1;
};

function compareRelease(a: string, b: string): number {
  if (isNumber(a) && isNumber(b)) return Math.sign(Number(a) - Number(b));
  if (!isNumber(a) && !isNumber(b)) return lexical(a, b);
  const [text, sign] = isNumber(a) ? [b, -1] : [a, 1];
  const number = isNumber(a) ? a : b;
  const leading = /^\d+/.exec(text)?.[0];
  if (leading === undefined) return sign;
  return Math.sign(Number(leading) - Number(number)) * sign || sign;
}

function comparePrerelease(a: string, b: string): number {
  if (isNumber(a) && isNumber(b)) return Math.sign(Number(a) - Number(b));
  if (isNumber(a)) return -1;
  if (isNumber(b)) return 1;
  return lexical(a, b);
}

function compareIds(a: readonly string[], b: readonly string[], compare: (x: string, y: string) => number, pad: string | undefined): number {
  const length = Math.max(a.length, b.length);
  for (let at = 0; at < length; at++) {
    const [x, y] = [a[at] ?? pad, b[at] ?? pad];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const result = compare(x, y);
    if (result !== 0) return result;
  }
  return 0;
}

/** Negative, zero or positive as `a` is before, equal to or after `b` in LOOT's version order. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parse(a), parse(b)];
  const release = compareIds(x.release, y.release, compareRelease, '0');
  if (release !== 0) return release;
  if (x.prerelease.length === 0 || y.prerelease.length === 0) return y.prerelease.length - x.prerelease.length;
  return compareIds(x.prerelease, y.prerelease, comparePrerelease, undefined);
}
