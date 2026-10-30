import type {
  BuildFile, BuildFileRead, GameDepot, Manifest, ManifestArchive, ManifestFile, ManifestPackage, ManifestRead, ManifestStep, ManifestTool, PackageEntry,
} from './manifest';

type Json = Record<string, unknown>;

type Saying = (file: string) => string;

class Unreadable extends Error {
  constructor(readonly says: Saying) {
    super();
  }
}

const unreadable = (where: string, why?: string | Saying): Unreadable => new Unreadable((file) => {
  const because = typeof why === 'function' ? why(file) : why;
  return `its ${file} cannot be read${where ? ` at ${where}` : ''}${because ? `: ${because}` : ''}`;
});

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const objectOf = (value: unknown, where: string): Json => {
  if (!isObject(value)) throw unreadable(where);
  return value;
};

const textOf = (value: unknown, where: string): string => {
  if (typeof value !== 'string') throw unreadable(where);
  return value;
};

const arrayOf = (value: unknown, where: string): unknown[] => {
  if (!Array.isArray(value)) throw unreadable(where);
  return value;
};

const stringsOf = (value: unknown, where: string): string[] => arrayOf(value, where).map((item) => textOf(item, where));

const required = (line: Json, key: string, where: string): unknown => {
  if (!Object.hasOwn(line, key)) throw unreadable(where);
  return line[key];
};

const known = (line: Json, part: string | undefined, keys: readonly string[]): void => {
  const unknownKey = Object.keys(line).find((key) => !keys.includes(key));
  if (unknownKey !== undefined) {
    throw new Unreadable((file) => `its ${file}${part === undefined ? '' : `'s ${part}`} holds '${unknownKey}', which Modbench does not read`);
  }
};

const isPathInTheFolder = (path: string): boolean =>
  !path.includes('\\') && !/^([a-zA-Z]:|\/)/.test(path) && path.split('/').every((segment) => segment.trim() !== '' && segment !== '.' && segment !== '..');

const inTheFolder = (key: string, paths: readonly string[]): void => {
  const outside = paths.find((path) => !isPathInTheFolder(path));
  if (outside !== undefined) throw new Unreadable((file) => `its ${file}'s '${key}' names '${outside}', which is not a path in the folder`);
};

const packageOf = (index: number, line: unknown): { pkg: ManifestPackage; version?: string } => {
  const where = `its package ${index + 1}`;
  const members = objectOf(line, where);
  known(members, `package ${index + 1}`, [
    'installationFile', 'size', 'hash', 'page', 'gameFolder', 'depots', 'submodule', 'repository', 'version',
  ]);
  const version = Object.hasOwn(members, 'version') ? textOf(members.version, where) : undefined;
  if (version !== undefined && index > 0) {
    throw new Unreadable((file) => `its ${file}'s package ${index + 1} holds a version, which belongs to the first package`);
  }
  const withVersion = (pkg: ManifestPackage): { pkg: ManifestPackage; version?: string } => (version === undefined ? { pkg } : { pkg, version });
  if (Object.hasOwn(members, 'installationFile')) {
    const size = required(members, 'size', where);
    if (typeof size !== 'number' || !Number.isSafeInteger(size)) throw unreadable(where);
    const name = textOf(members.installationFile, where);
    const hash = textOf(required(members, 'hash', where), where);
    return withVersion(Object.hasOwn(members, 'page') ? { kind: 'installationFile', name, size, hash, page: textOf(members.page, where) } : { kind: 'installationFile', name, size, hash });
  }
  if (Object.hasOwn(members, 'gameFolder')) {
    const depots: GameDepot[] = Object.hasOwn(members, 'depots')
      ? Object.entries(objectOf(members.depots, where)).map(([id, depotVersion]) => ({ id, version: textOf(depotVersion, where) }))
      : [];
    return withVersion({ kind: 'gameFolder', name: textOf(members.gameFolder, where), hash: textOf(required(members, 'hash', where), where), depots });
  }
  if (Object.hasOwn(members, 'submodule')) return withVersion({ kind: 'sourceRepository', name: textOf(members.submodule, where), isSubmodule: true });
  return withVersion({ kind: 'sourceRepository', name: textOf(required(members, 'repository', where), where), isSubmodule: false });
};

const packagesOf = (value: unknown): { packages: ManifestPackage[]; version?: string } => {
  const packages: ManifestPackage[] = [];
  let version: string | undefined;
  arrayOf(value, 'its packages').forEach((line, index) => {
    const read = packageOf(index, line);
    if (packages.some((other) => other.name === read.pkg.name)) throw new Unreadable((file) => `its ${file} names the package '${read.pkg.name}' twice`);
    packages.push(read.pkg);
    if (index === 0) version = read.version;
  });
  return version === undefined ? { packages } : { packages, version };
};

const stepOf = (index: number, line: unknown): ManifestStep => {
  const where = `its step ${index + 1}`;
  const members = objectOf(line, where);
  known(members, `step ${index + 1}`, ['task', 'args']);
  const task = textOf(required(members, 'task', where), where);
  if (task.trim() === '') throw unreadable(where, 'it names no task');
  return { task, args: Object.hasOwn(members, 'args') ? stringsOf(members.args, where) : [] };
};

const toolOf = (index: number, line: unknown): ManifestTool => {
  const where = `its tool ${index + 1}`;
  const members = objectOf(line, where);
  known(members, `tool ${index + 1}`, ['task', 'page']);
  const task = textOf(required(members, 'task', where), where);
  const page = textOf(required(members, 'page', where), where);
  if (task.trim() === '') throw unreadable(where, 'it names no task');
  if (page.trim() === '') throw unreadable(where, 'it names no page');
  return { task, page };
};

const fileProblem = (index: number, why: string | Saying): Unreadable => unreadable(`its file ${index + 1}`, why);

const flagOf = (index: number, line: Json, key: string, written: boolean): boolean => {
  if (!Object.hasOwn(line, key)) return false;
  const flag = line[key];
  if (typeof flag !== 'boolean') throw unreadable(`its file ${index + 1}`);
  if (flag !== written) throw fileProblem(index, `its ${key} is ${written ? 'false' : 'true'}`);
  return true;
};

const fileOf = (index: number, line: unknown): ManifestFile => {
  const where = `its file ${index + 1}`;
  const members = objectOf(line, where);
  known(members, `file ${index + 1}`, ['path', 'package', 'packagePath', 'inPackage', 'otherBytes', 'madeByStep']);
  const path = textOf(required(members, 'path', where), where);
  const flags: { set: boolean; says: string; entry: PackageEntry }[] = [
    { set: flagOf(index, members, 'inPackage', false), says: 'its package does not hold the file', entry: { kind: 'notHeld' } },
    { set: flagOf(index, members, 'otherBytes', true), says: 'its package holds it with other bytes', entry: { kind: 'otherBytes' } },
    { set: flagOf(index, members, 'madeByStep', true), says: 'a step makes it', entry: { kind: 'madeByStep' } },
  ];
  const says = flags.filter((flag) => flag.set);
  const movedTo = Object.hasOwn(members, 'packagePath') ? textOf(members.packagePath, where) : undefined;
  const named = Object.hasOwn(members, 'package') ? textOf(members.package, where) : undefined;
  const withPackage = (entry: PackageEntry): ManifestFile => (named === undefined ? { path, entry } : { path, entry, package: named });
  const [only, other] = says;
  if (only && other) throw fileProblem(index, `it says both that ${only.says} and that ${other.says}`);
  if (only && movedTo !== undefined) {
    throw fileProblem(index, 'it names a path in its package for a file its package does not hold with its bytes');
  }
  if (only) {
    if (only.entry.kind === 'madeByStep' && named !== undefined) throw fileProblem(index, 'it names a package for a file a step makes');
    return withPackage(only.entry);
  }
  return withPackage(movedTo === undefined ? { kind: 'held' } : { kind: 'heldAt', path: movedTo });
};

const archivesOf = (value: unknown): ManifestArchive[] => {
  const archives = Object.entries(objectOf(value, 'its archives')).map(([path, files]) => ({ path, files: stringsOf(files, 'its archives') }));
  inTheFolder('archives', [...archives.map((archive) => archive.path), ...archives.flatMap((archive) => archive.files)]);
  return archives;
};

const MANIFEST_KEYS = ['packages', 'archives', 'tools', 'files', 'exclude'];

const BUILD_FILE_KEYS = ['packages', 'archives', 'steps', 'tools', 'files'];

const buildFileOf = (text: string, keys: readonly string[]): BuildFile => {
  const root = objectOf(JSON.parse(text), '');
  known(root, undefined, keys);
  const files = arrayOf(required(root, 'files', ''), 'its files').map((line, index) => fileOf(index, line));
  const steps = Object.hasOwn(root, 'steps') ? arrayOf(root.steps, 'its steps').map((line, index) => stepOf(index, line)) : [];
  const tools = Object.hasOwn(root, 'tools') ? arrayOf(root.tools, 'its tools').map((line, index) => toolOf(index, line)) : [];
  const { packages, version } = Object.hasOwn(root, 'packages') ? packagesOf(root.packages) : { packages: [] as ManifestPackage[], version: undefined };
  const unnamed = files.findIndex((file) => file.package !== undefined && packages.every((pkg) => pkg.name !== file.package));
  if (unnamed >= 0) throw fileProblem(unnamed, (file) => `it names a package the ${file} does not name`);
  const madeByStep = files.findIndex((file) => file.entry.kind === 'madeByStep');
  if (keys.includes('steps') && steps.length === 0 && madeByStep >= 0) throw fileProblem(madeByStep, (file) => `it says a step makes the file, and the ${file} holds no step`);
  const exclude = Object.hasOwn(root, 'exclude') ? stringsOf(root.exclude, 'its exclude') : [];
  inTheFolder('exclude', exclude);
  return {
    packages,
    ...(version === undefined ? {} : { version }),
    exclude,
    archives: Object.hasOwn(root, 'archives') ? archivesOf(root.archives) : [],
    steps,
    tools,
    files,
  };
};

const leavesTheTextIncomplete = (prefix: string): boolean => {
  try {
    JSON.parse(prefix);
    return false;
  } catch (problem) {
    const message = problem instanceof Error ? problem.message : '';
    const position = /at position (\d+)/.exec(message)?.[1];
    return /end of JSON input/.test(message) || (position !== undefined && Number(position) >= prefix.length);
  }
};

const firstUnparsableLength = (text: string): number => {
  let [low, high] = [0, text.length];
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (leavesTheTextIncomplete(text.slice(0, middle))) low = middle + 1;
    else high = middle;
  }
  return low;
};

const lineOf = (problem: SyntaxError, text: string): string => {
  const reported = /\(line (\d+) column/.exec(problem.message)?.[1];
  if (reported !== undefined) return ` at line ${reported}`;
  const offending = firstUnparsableLength(text) - 1;
  return offending < 0 ? '' : ` at line ${text.slice(0, offending).split('\n').length}`;
};

const read = <Read extends Manifest>(text: string, file: string, keys: readonly string[], shaped: (read: BuildFile) => Read): { readonly manifest: Read } | { readonly refused: string } => {
  try {
    return { manifest: shaped(buildFileOf(text, keys)) };
  } catch (problem) {
    if (problem instanceof Unreadable) return { refused: problem.says(file) };
    if (problem instanceof SyntaxError) return { refused: `its ${file} cannot be read${lineOf(problem, text)}` };
    throw problem;
  }
};

/** `text` read as a manifest. */
export const readManifest = (text: string): ManifestRead =>
  read(text, 'manifest', MANIFEST_KEYS, ({ steps: _none, ...manifest }) => manifest);

/** `text` read as a build file, which shares a manifest's form but holds no exclusion: those are the modlist's (mods.md, A
 *  source mod, story 2). */
export const readBuildFile = (text: string): BuildFileRead => read(text, 'build file', BUILD_FILE_KEYS, (file) => file);
