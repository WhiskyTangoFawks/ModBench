// MO2's VersionInfo (modorganizer-uibase, src/versioninfo.cpp): how it parses a version string
// and orders two. meta.ini holds the canonical strings it writes, so the format is MO2's.

type Scheme = 'regular' | 'decimal' | 'numbersAndLetters' | 'date' | 'literal';

const RELEASES = ['prealpha', 'alpha', 'beta', 'rc'] as const;
const FINAL = RELEASES.length;

// std::map<QString, ReleaseType> iterates its keys in this order, so "prealpha" reads as "alpha".
const RELEASE_SEARCH_ORDER: readonly (typeof RELEASES)[number][] = ['alpha', 'beta', 'prealpha', 'rc'];

interface Version {
  scheme: Scheme;
  valid: boolean;
  release: number;
  major: number;
  minor: number;
  subMinor: number;
  subSubMinor: number;
  decimalPositions: number;
  rest: string;
}

const NUMBERS = /^(\d+)(\.(\d+))?(\.(\d+))?(\.(\d+))?/;
const INTEGER = /^[+-]?\d+$/;
const SCHEME_HINTS: Record<string, Scheme> = { f: 'decimal', n: 'numbersAndLetters', d: 'date' };

const integerOf = (text: string | undefined): number => (text === undefined ? 0 : Number(text));

function withoutRelease(text: string, version: Version): string {
  version.release = FINAL;
  const lower = text.toLowerCase();
  const kind = RELEASE_SEARCH_ORDER.find((name) => lower.includes(name));
  if (kind !== undefined) {
    version.release = RELEASES.indexOf(kind);
    const at = lower.indexOf(kind);
    return (text.slice(0, at) + text.slice(at + kind.length)).trim();
  }
  const letter = text.charAt(0);
  if (letter === 'a' || letter === 'b') {
    version.release = RELEASES.indexOf(letter === 'a' ? 'alpha' : 'beta');
    return text.slice(1).trim();
  }
  return text.trim();
}

function parse(versionString: string): Version {
  const version: Version = {
    scheme: 'regular', valid: false, release: FINAL, major: 0, minor: 0, subMinor: 0, subSubMinor: 0, decimalPositions: 0, rest: '',
  };
  if (versionString.length === 0) return version;
  if (versionString.toLowerCase() === 'final') return { ...version, major: 1, valid: true };

  let text = versionString;
  const hinted = SCHEME_HINTS[text.charAt(0)];
  if (hinted !== undefined) {
    version.scheme = hinted;
    text = text.slice(1);
  }
  if (text.toLowerCase().startsWith('v')) text = text.slice(1);

  const match = NUMBERS.exec(text);
  if (match === null) {
    version.scheme = 'literal';
  } else {
    const [whole, major, , minor = '', , subMinor, , subSubMinor] = match;
    version.major = integerOf(major);
    version.minor = integerOf(minor);
    if (subMinor !== undefined && version.scheme === 'decimal') version.scheme = 'regular';
    if (version.scheme !== 'decimal') {
      version.subMinor = integerOf(subMinor);
      version.subSubMinor = integerOf(subSubMinor);
    }
    if (subMinor === undefined && minor.length > 1 && minor.startsWith('0')) {
      version.scheme = 'decimal';
      version.decimalPositions = minor.length;
    }
    text = text.slice(whole.length);
  }
  if (version.scheme === 'regular') text = withoutRelease(text, version);
  if (version.scheme === 'date' && version.major < 1900) version.scheme = 'regular';
  version.rest = text.trim();
  version.valid = true;
  return version;
}

const decimalValueOf = ({ major, minor, decimalPositions }: Version): number =>
  Math.fround(Number(`${major}.${String(minor).padStart(decimalPositions, '0')}`));

function isBefore(left: Version, right: Version): boolean {
  if (!left.valid && right.valid) return true;
  if (!right.valid && left.valid) return false;
  if ((left.scheme === 'date') !== (right.scheme === 'date')) return left.scheme === 'date';
  if (left.scheme === 'decimal' || right.scheme === 'decimal') {
    const [a, b] = [decimalValueOf(left), decimalValueOf(right)];
    if (Math.abs(a - b) > 0.001) return a < b;
  } else {
    for (const field of ['major', 'minor', 'subMinor', 'subSubMinor'] as const) {
      if (left[field] !== right[field]) return left[field] < right[field];
    }
  }
  if (left.release !== right.release) return left.release < right.release;
  if (INTEGER.test(left.rest) && INTEGER.test(right.rest)) return Number(left.rest) < Number(right.rest);
  return left.rest < right.rest;
}

const SCHEME_PREFIXES: Partial<Record<Scheme, string>> = { regular: '', numbersAndLetters: 'n', date: 'd' };
const RELEASE_SUFFIXES = [' pre-alpha', 'a', 'b', 'rc'];

/** VersionInfo::canonicalString: the form MO2 writes a version in; empty for a version that is not one. */
export function canonicalVersion(versionString: string): string {
  const version = parse(versionString);
  if (!version.valid) return '';
  const { scheme, major, minor, subMinor, subSubMinor } = version;
  let numbers = '';
  if (scheme === 'decimal') numbers = `f${major}.${String(minor).padStart(version.decimalPositions, '0')}`;
  else if (scheme !== 'literal') numbers = `${SCHEME_PREFIXES[scheme]}${major}.${minor}.${subMinor}.${subSubMinor}`;
  return `${numbers}${RELEASE_SUFFIXES[version.release] ?? ''}${version.rest}`;
}

/** Whether MO2 shows an update for a mod at `version` whose newest is `newest`: the newest one is
 *  a version, and the mod's, valid or not, orders before it. */
export function isUpdateAvailable(version: string | undefined, newest: string | undefined): boolean {
  const latest = parse(newest ?? '');
  return latest.valid && isBefore(parse(version ?? ''), latest);
}
