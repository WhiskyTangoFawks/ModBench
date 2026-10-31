import type {
  BuildFile, BuildFileLine, BuildFilePackage, BuildFileRead, GameDepot, ManifestArchive, ManifestStep, ManifestTool, PackageEntry,
} from './buildFile';
import { arrayOf, isPathInTheFolder, known as knownIn, objectOf, parsed, required, stringsOf, textOf, unreadable, Unreadable, type Json } from './jsonRead';

const FILE = 'build file';

const known = (members: Json, part: string | undefined, keys: readonly string[]): void => { knownIn(FILE, members, part, keys); };

const inTheFolder = (key: string, paths: readonly string[]): void => {
  const outside = paths.find((path) => !isPathInTheFolder(path));
  if (outside !== undefined) throw new Unreadable(`its ${FILE}'s '${key}' names '${outside}', which is not a path in the folder`);
};

const packageLineOf = (index: number, line: unknown): BuildFilePackage => {
  const where = `its package ${index + 1}`;
  const members = objectOf(FILE, line, where);
  known(members, `package ${index + 1}`, ['installationFile', 'size', 'hash', 'page', 'gameFolder', 'depots']);
  if (Object.hasOwn(members, 'installationFile')) {
    const size = required(FILE, members, 'size', where);
    if (typeof size !== 'number' || !Number.isSafeInteger(size)) throw unreadable(FILE, where);
    const name = textOf(FILE, members.installationFile, where);
    const hash = textOf(FILE, required(FILE, members, 'hash', where), where);
    return Object.hasOwn(members, 'page')
      ? { kind: 'installationFile', name, size, hash, page: textOf(FILE, members.page, where) }
      : { kind: 'installationFile', name, size, hash };
  }
  const depots: GameDepot[] = Object.hasOwn(members, 'depots')
    ? Object.entries(objectOf(FILE, members.depots, where)).map(([id, depotVersion]) => ({ id, version: textOf(FILE, depotVersion, where) }))
    : [];
  return { kind: 'gameFolder', name: textOf(FILE, required(FILE, members, 'gameFolder', where), where), hash: textOf(FILE, required(FILE, members, 'hash', where), where), depots };
};

const packagesOf = (value: unknown): BuildFilePackage[] => {
  const packages: BuildFilePackage[] = [];
  arrayOf(FILE, value, 'its packages').forEach((line, index) => {
    const pkg = packageLineOf(index, line);
    if (packages.some((other) => other.name === pkg.name)) throw new Unreadable(`its ${FILE} names the package '${pkg.name}' twice`);
    packages.push(pkg);
  });
  return packages;
};

const stepOf = (index: number, line: unknown): ManifestStep => {
  const where = `its step ${index + 1}`;
  const members = objectOf(FILE, line, where);
  known(members, `step ${index + 1}`, ['task', 'args']);
  const task = textOf(FILE, required(FILE, members, 'task', where), where);
  if (task.trim() === '') throw unreadable(FILE, where, 'it names no task');
  return { task, args: Object.hasOwn(members, 'args') ? stringsOf(FILE, members.args, where) : [] };
};

const toolOf = (index: number, line: unknown): ManifestTool => {
  const where = `its tool ${index + 1}`;
  const members = objectOf(FILE, line, where);
  known(members, `tool ${index + 1}`, ['task', 'page']);
  const task = textOf(FILE, required(FILE, members, 'task', where), where);
  const page = textOf(FILE, required(FILE, members, 'page', where), where);
  if (task.trim() === '') throw unreadable(FILE, where, 'it names no task');
  if (page.trim() === '') throw unreadable(FILE, where, 'it names no page');
  return { task, page };
};

const fileProblem = (index: number, why: string): Unreadable => unreadable(FILE, `its file ${index + 1}`, why);

const flagOf = (index: number, line: Json, key: string, written: boolean): boolean => {
  if (!Object.hasOwn(line, key)) return false;
  const flag = line[key];
  if (typeof flag !== 'boolean') throw unreadable(FILE, `its file ${index + 1}`);
  if (flag !== written) throw fileProblem(index, `its ${key} is ${written ? 'false' : 'true'}`);
  return true;
};

const fileOf = (index: number, line: unknown): BuildFileLine => {
  const where = `its file ${index + 1}`;
  const members = objectOf(FILE, line, where);
  known(members, `file ${index + 1}`, ['path', 'package', 'packagePath', 'inPackage', 'otherBytes', 'madeByStep']);
  const path = textOf(FILE, required(FILE, members, 'path', where), where);
  const flags: { set: boolean; says: string; entry: PackageEntry }[] = [
    { set: flagOf(index, members, 'inPackage', false), says: 'its package does not hold the file', entry: { kind: 'notHeld' } },
    { set: flagOf(index, members, 'otherBytes', true), says: 'its package holds it with other bytes', entry: { kind: 'otherBytes' } },
    { set: flagOf(index, members, 'madeByStep', true), says: 'a step makes it', entry: { kind: 'madeByStep' } },
  ];
  const says = flags.filter((flag) => flag.set);
  const movedTo = Object.hasOwn(members, 'packagePath') ? textOf(FILE, members.packagePath, where) : undefined;
  const named = Object.hasOwn(members, 'package') ? textOf(FILE, members.package, where) : undefined;
  const withPackage = (entry: PackageEntry): BuildFileLine => ({ path, entry, ...(named === undefined ? {} : { package: named }) });
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
  const archives = Object.entries(objectOf(FILE, value, 'its archives')).map(([path, files]) => ({ path, files: stringsOf(FILE, files, 'its archives') }));
  inTheFolder('archives', [...archives.map((archive) => archive.path), ...archives.flatMap((archive) => archive.files)]);
  return archives;
};

const buildFileOf = (value: unknown): BuildFile => {
  const root = objectOf(FILE, value, '');
  known(root, undefined, ['packages', 'archives', 'steps', 'tools', 'files']);
  const files = arrayOf(FILE, required(FILE, root, 'files', ''), 'its files').map((line, index) => fileOf(index, line));
  const steps = Object.hasOwn(root, 'steps') ? arrayOf(FILE, root.steps, 'its steps').map((line, index) => stepOf(index, line)) : [];
  const tools = Object.hasOwn(root, 'tools') ? arrayOf(FILE, root.tools, 'its tools').map((line, index) => toolOf(index, line)) : [];
  const packages = Object.hasOwn(root, 'packages') ? packagesOf(root.packages) : [];
  const unnamed = files.findIndex((file) => file.package !== undefined && packages.every((pkg) => pkg.name !== file.package));
  if (unnamed >= 0) throw fileProblem(unnamed, `it names a package the ${FILE} does not name`);
  const madeByStep = files.findIndex((file) => file.entry.kind === 'madeByStep');
  if (steps.length === 0 && madeByStep >= 0) throw fileProblem(madeByStep, `it says a step makes the file, and the ${FILE} holds no step`);
  return { packages, archives: Object.hasOwn(root, 'archives') ? archivesOf(root.archives) : [], steps, tools, files };
};

/** `text` read as a build file, which holds no exclusion: those are the modlist's (mods.md, A source mod, story 2). */
export const readBuildFile = (text: string): BuildFileRead => {
  const read = parsed(text, FILE, buildFileOf);
  return 'refused' in read ? read : { buildFile: read.read };
};

/** The package a line's file comes from: the one the line names, else the build file's first. */
export const packageOf = (buildFile: Pick<BuildFile, 'packages'>, line: BuildFileLine): BuildFilePackage | undefined =>
  (line.package === undefined ? buildFile.packages[0] : buildFile.packages.find(({ name }) => name === line.package));
