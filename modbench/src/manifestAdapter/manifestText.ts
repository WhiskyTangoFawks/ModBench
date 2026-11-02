// spec/formats/manifest.md, Canonical text.

import { MANIFEST_VERSION, type Manifest, type ManifestPackage } from './manifest';

const upperUnit = (unit: string): string => {
  const upper = unit.toUpperCase();
  return upper.length === 1 ? upper : unit;
};
const upperUnits = (text: string): string => Array.from(text, upperUnit).join('');
export const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
// The order a manifest lists paths and installation files in.
const ordinalIgnoreCaseThenOrdinal = (a: string, b: string): number =>
  ordinal(upperUnits(a), upperUnits(b)) || ordinal(a, b);

const KINDS: readonly ManifestPackage['kind'][] = ['installationFile', 'gameFolder', 'repository'];

const nameOf = (pkg: ManifestPackage): string => ('name' in pkg ? pkg.name : '');

// Each object's members in the schema's order, so JSON.stringify keeps it.
const packageObject = (pkg: ManifestPackage): object => {
  switch (pkg.kind) {
    case 'installationFile': {
      const { name, size, hash, host } = pkg;
      const hosted = host === undefined ? undefined : 'url' in host ? { url: host.url } : { nexus: { game: host.nexus.game, mod: host.nexus.mod, file: host.nexus.file } };
      return { kind: pkg.kind, name, size, hash, ...hosted === undefined ? {} : { host: hosted } };
    }
    case 'gameFolder': {
      const steam = pkg.host?.steam;
      return steam === undefined
        ? { kind: pkg.kind }
        : { kind: pkg.kind, host: { steam: { app: steam.app, ...steam.depots === undefined ? {} : { depots: steam.depots } } } };
    }
    case 'repository':
      return { kind: pkg.kind, name: pkg.name };
  }
};

const block = (key: string, open: string, close: string, lines: readonly string[]): string[] =>
  (lines.length === 0 ? [] : [`${JSON.stringify(key)}:${open}\n${lines.join(',\n')}\n${close}`]);

const flagsText = (set: Readonly<Record<string, boolean>>): string =>
  `{${Object.keys(set).sort(ordinalIgnoreCaseThenOrdinal).map((name) => `${JSON.stringify(name)}:${JSON.stringify(set[name])}`).join(',')}}`;

export function manifestText({ packages, exclude, ignore, flags, files }: Manifest): string {
  const ordered = [...packages].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || ordinalIgnoreCaseThenOrdinal(nameOf(a), nameOf(b)));
  const paths = [...files.keys()].sort(ordinalIgnoreCaseThenOrdinal);
  const members = [
    `"version":${MANIFEST_VERSION}`,
    ...block('packages', '[', ']', ordered.map((pkg) => JSON.stringify(packageObject(pkg)))),
    ...block('exclude', '[', ']', [...exclude].sort(ordinalIgnoreCaseThenOrdinal).map((path) => JSON.stringify(path))),
    ...block('ignore', '[', ']', [...ignore].sort(ordinalIgnoreCaseThenOrdinal).map((path) => JSON.stringify(path))),
    ...block('flags', '{', '}', [...flags.keys()].sort(ordinalIgnoreCaseThenOrdinal).map((path) => `${JSON.stringify(path)}:${flagsText(flags.get(path) ?? {})}`)),
    ...block('files', '{', '}', paths.map((path) => `${JSON.stringify(path)}:${JSON.stringify(files.get(path) ?? null)}`)),
  ];
  return `{\n${members.join(',\n')}\n}\n`;
}
