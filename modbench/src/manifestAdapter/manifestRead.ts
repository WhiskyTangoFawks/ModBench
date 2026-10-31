// spec/formats/manifest-1.schema.json and the rules manifest.md adds, read from any text the schema accepts.

import { MANIFEST_VERSION, type Manifest, type ManifestPackage, type ManifestRead } from './manifest';
import { arrayOf, isObject, objectOf, parsed, required, textOf, unreadable, Unreadable, type Json } from './jsonRead';

const FILE = 'manifest';

const PATH = /^(?!\/)(?!.*\/$)(?!.*\/\/)(?!(?:.*\/)?\.{1,2}(?:\/|$))[^\\]+$/;
const HASH = /^[A-Za-z0-9+/]{10}[AEIMQUYcgkosw048]=$/;
const NEXUS_GAME = /^[a-z0-9]+$/;
const DIGITS = /^[0-9]+$/;

class VersionRefused extends Error {}

const at = (where: string): Unreadable => unreadable(FILE, where);

const known = (members: Json, part: string | undefined, keys: readonly string[]): void => {
  const unknownKey = Object.keys(members).find((key) => !keys.includes(key));
  if (unknownKey !== undefined) {
    throw new Unreadable(`its ${FILE}${part === undefined ? '' : `'s ${part}`} holds '${unknownKey}', which Modbench does not read`);
  }
};

const countOf = (value: unknown, minimum: number, where: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw at(where);
  return value;
};

const matching = (value: unknown, pattern: RegExp, where: string): string => {
  const text = textOf(FILE, value, where);
  if (!pattern.test(text)) throw at(where);
  return text;
};

const hostOf = (value: unknown, kind: string, where: string): Json => {
  const host = objectOf(FILE, value, where);
  if (Object.keys(host).length !== 1 || !Object.hasOwn(host, kind)) throw at(where);
  return objectOf(FILE, host[kind], where);
};

const exactly = (members: Json, keys: readonly string[], where: string): void => {
  if (Object.keys(members).some((key) => !keys.includes(key))) throw at(where);
};

function installationFileOf(members: Json, where: string, part: string): ManifestPackage {
  known(members, part, ['kind', 'name', 'size', 'hash', 'host']);
  const name = textOf(FILE, required(FILE, members, 'name', where), where);
  if (name === '') throw at(where);
  const size = countOf(required(FILE, members, 'size', where), 0, where);
  const hash = matching(required(FILE, members, 'hash', where), HASH, where);
  if (!Object.hasOwn(members, 'host')) return { kind: 'installationFile', name, size, hash };
  const nexus = hostOf(members.host, 'nexus', where);
  exactly(nexus, ['game', 'mod', 'file'], where);
  const file = {
    game: matching(required(FILE, nexus, 'game', where), NEXUS_GAME, where),
    mod: countOf(required(FILE, nexus, 'mod', where), 1, where),
    file: countOf(required(FILE, nexus, 'file', where), 1, where),
  };
  return { kind: 'installationFile', name, size, hash, host: { nexus: file } };
}

function gameFolderOf(members: Json, where: string, part: string): ManifestPackage {
  known(members, part, ['kind', 'host']);
  if (!Object.hasOwn(members, 'host')) return { kind: 'gameFolder' };
  const steam = hostOf(members.host, 'steam', where);
  exactly(steam, ['app', 'depots'], where);
  const app = countOf(required(FILE, steam, 'app', where), 1, where);
  if (!Object.hasOwn(steam, 'depots')) return { kind: 'gameFolder', host: { steam: { app } } };
  const depots = Object.entries(objectOf(FILE, steam.depots, where)).map(([id, version]) => {
    if (!DIGITS.test(id)) throw at(where);
    return [id, matching(version, DIGITS, where)] as const;
  });
  return { kind: 'gameFolder', host: { steam: { app, depots: Object.fromEntries(depots) } } };
}

function packageOf(line: unknown, index: number): ManifestPackage {
  const where = `its package ${index + 1}`;
  const part = `package ${index + 1}`;
  const members = objectOf(FILE, line, where);
  switch (members.kind) {
    case 'installationFile': return installationFileOf(members, where, part);
    case 'gameFolder': return gameFolderOf(members, where, part);
    case 'repository': {
      known(members, part, ['kind', 'name']);
      const name = textOf(FILE, required(FILE, members, 'name', where), where);
      if (name === '') throw at(where);
      return { kind: 'repository', name };
    }
    default: throw at(where);
  }
}

function packagesOf(value: unknown): ManifestPackage[] {
  const packages = arrayOf(FILE, value, 'its packages').map(packageOf);
  const names = packages.flatMap((pkg) => (pkg.kind === 'installationFile' ? [pkg.name] : []));
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice !== undefined) throw new Unreadable(`its ${FILE} names the installation file '${twice}' twice`);
  if (packages.filter(({ kind }) => kind === 'gameFolder').length > 1) throw new Unreadable(`its ${FILE} names the game folder twice`);
  const repository = packages.find((pkg) => pkg.kind === 'repository');
  if (repository !== undefined && packages.length > 1) throw new Unreadable(`its ${FILE} names the repository '${repository.name}' beside another package`);
  return packages;
}

const pathOf = (path: string): string => {
  if (!PATH.test(path)) throw new Unreadable(`its ${FILE} names '${path}', which is not a path in the folder`);
  return path;
};

function filesOf(value: unknown, built: boolean): Map<string, string | null> {
  const files = new Map<string, string | null>();
  const byFolded = new Map<string, string>();
  for (const [path, hash] of Object.entries(objectOf(FILE, value, 'its files'))) {
    const where = `its file '${path}'`;
    if (hash === null && !built) throw unreadable(FILE, where, "only a source mod's manifest names a file a step makes");
    files.set(pathOf(path), hash === null ? null : matching(hash, HASH, where));
    const other = byFolded.get(path.toLowerCase());
    if (other !== undefined) throw new Unreadable(`its ${FILE} names '${other}' and '${path}', which differ only by case`);
    byFolded.set(path.toLowerCase(), path);
  }
  return files;
}

function excludeOf(value: unknown, files: ReadonlyMap<string, unknown>): string[] {
  const exclude = arrayOf(FILE, value, 'its exclude').map((path) => pathOf(textOf(FILE, path, 'its exclude')));
  const twice = exclude.find((path, index) => exclude.indexOf(path) !== index);
  if (twice !== undefined) throw new Unreadable(`its ${FILE} excludes '${twice}' twice`);
  const paths = [...files.keys()];
  const stray = exclude.find((path) => !paths.some((file) => file === path || file.startsWith(`${path}/`)));
  if (stray !== undefined) throw new Unreadable(`its ${FILE} excludes '${stray}', which is none of its files nor a folder above one`);
  return exclude;
}

function manifestOf(value: unknown): Manifest {
  if (isObject(value) && !Object.hasOwn(value, 'version')) {
    throw new VersionRefused(`its ${FILE} is in a format before version ${MANIFEST_VERSION}, and Modbench reads only version ${MANIFEST_VERSION}`);
  }
  const root = objectOf(FILE, value, '');
  if (root.version !== MANIFEST_VERSION) {
    throw new VersionRefused(`its ${FILE} is version ${JSON.stringify(root.version)}, and Modbench reads only version ${MANIFEST_VERSION}`);
  }
  known(root, undefined, ['version', 'packages', 'exclude', 'files']);
  const packages = Object.hasOwn(root, 'packages') ? packagesOf(root.packages) : [];
  const files = Object.hasOwn(root, 'files') ? filesOf(root.files, packages.some(({ kind }) => kind === 'repository')) : new Map<string, string | null>();
  return { packages, exclude: Object.hasOwn(root, 'exclude') ? excludeOf(root.exclude, files) : [], files };
}

/** `text` read as a manifest of version 1. */
export function readManifest(text: string): ManifestRead {
  try {
    const read = parsed(text, FILE, manifestOf);
    return 'refused' in read ? read : { manifest: read.read };
  } catch (problem) {
    if (problem instanceof VersionRefused) return { refused: problem.message, versionRefused: true };
    throw problem;
  }
}
