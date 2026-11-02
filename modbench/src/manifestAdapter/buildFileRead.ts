// spec/formats/build-file-1.schema.json, read from any text the schema accepts.

import { BUILD_FILE_VERSION, type BuildFile, type BuildFileRead, type BuildStep, type DefaultScriptStep, type ManifestArchive, type ScriptStep, type TaskStep } from './buildFile';
import { arrayOf, isObject, isPathInTheFolder, known as knownIn, objectOf, parsed, stringsOf, textOf, unreadable, Unreadable, type Json } from './jsonRead';

const FILE = 'build file';

const KINDS = ['decompile', 'compile', 'copy', 'pack', 'task', 'script', 'defaultScript'] as const;

const known = (members: Json, part: string | undefined, keys: readonly string[]): void => { knownIn(FILE, members, part, keys); };

const inTheFolder = (step: string, paths: readonly string[]): void => {
  const outside = paths.find((path) => !isPathInTheFolder(path));
  if (outside !== undefined) throw new Unreadable(`its ${FILE}'s ${step} names '${outside}', which is not a path in the folder`);
};

const pathsOf = (where: string, step: string, value: unknown): string[] => {
  const paths = stringsOf(FILE, value, where);
  if (paths.length === 0) throw unreadable(FILE, where, 'it names no path');
  const twice = paths.find((path, at) => paths.indexOf(path) !== at);
  if (twice !== undefined) throw unreadable(FILE, where, `it names '${twice}' twice`);
  inTheFolder(step, paths);
  return paths;
};

const taskOf = (where: string, step: string, members: Json): TaskStep => {
  known(members, step, ['task', 'args', 'page']);
  const task = textOf(FILE, members.task, where);
  if (task.trim() === '') throw unreadable(FILE, where, 'it names no task');
  const args = Object.hasOwn(members, 'args') ? stringsOf(FILE, members.args, where) : [];
  if (!Object.hasOwn(members, 'page')) return { kind: 'task', task, args };
  const page = textOf(FILE, members.page, where);
  if (!URL.canParse(page)) throw unreadable(FILE, where, 'its page is not a URI');
  return { kind: 'task', task, args, page };
};

const scriptOf = (where: string, step: string, members: Json): ScriptStep | DefaultScriptStep => {
  const args = Object.hasOwn(members, 'args') ? stringsOf(FILE, members.args, where) : [];
  if (Object.hasOwn(members, 'defaultScript')) {
    known(members, step, ['defaultScript', 'args']);
    const name = textOf(FILE, members.defaultScript, where);
    if (name === '') throw unreadable(FILE, where, 'it names no default script');
    return { kind: 'defaultScript', name, args };
  }
  known(members, step, ['script', 'args']);
  const script = textOf(FILE, members.script, where);
  inTheFolder(step, [script]);
  return { kind: 'script', script, args };
};

// formats/build-file.md: no two archives of one pack step pack one path.
const archivesOf = (where: string, step: string, value: unknown): ManifestArchive[] => {
  const archives = Object.entries(objectOf(FILE, value, where)).map(([path, files]) => ({ path, files: stringsOf(FILE, files, where) }));
  if (archives.length === 0) throw unreadable(FILE, where, 'it names no archive');
  const empty = archives.find(({ files }) => files.length === 0);
  if (empty !== undefined) throw unreadable(FILE, where, `it names no file for '${empty.path}'`);
  inTheFolder(step, [...archives.map((archive) => archive.path), ...archives.flatMap((archive) => archive.files)]);
  const packedBy = new Map<string, { readonly archive: string; readonly file: string }>();
  for (const { path: archive, files } of archives) {
    for (const file of files) {
      const other = packedBy.get(file.toLowerCase());
      if (other?.archive === archive) {
        const same = other.file === file ? `twice in '${archive}'` : `as '${other.file}' and '${file}' in '${archive}', which differ only by case`;
        throw new Unreadable(`its ${FILE}'s ${step} names '${file}' ${same}`);
      }
      if (other !== undefined) throw new Unreadable(`its ${FILE}'s ${step} names '${file}' in both '${other.archive}' and '${archive}'`);
      packedBy.set(file.toLowerCase(), { archive, file });
    }
  }
  return archives;
};

const stepOf = (index: number, line: unknown): BuildStep => {
  const [where, step] = [`its step ${index + 1}`, `step ${index + 1}`];
  const members = objectOf(FILE, line, where);
  const kinds = KINDS.filter((kind) => Object.hasOwn(members, kind));
  const [kind, other] = kinds;
  if (kind === undefined) {
    known(members, step, []);
    throw unreadable(FILE, where, 'it names no step');
  }
  if (other !== undefined) throw unreadable(FILE, where, `it names both '${kind}' and '${other}'`);
  if (kind === 'task') return taskOf(where, step, members);
  if (kind === 'script' || kind === 'defaultScript') return scriptOf(where, step, members);
  known(members, step, [kind]);
  if (kind === 'pack') return { kind, archives: archivesOf(where, step, members.pack) };
  const paths = pathsOf(where, step, members[kind]);
  const inAFolder = kind === 'copy' ? undefined : paths.find((path) => path.includes('/'));
  if (inAFolder !== undefined) throw unreadable(FILE, where, `it names '${inAFolder}', which is not a plugin at the root`);
  return { kind, paths };
};

const buildFileOf = (value: unknown): BuildFile => {
  if (isObject(value) && !Object.hasOwn(value, 'version')) {
    throw new Unreadable(`its ${FILE} is in a format before version ${BUILD_FILE_VERSION}, and Modbench reads only version ${BUILD_FILE_VERSION}`);
  }
  const root = objectOf(FILE, value, '');
  if (root.version !== BUILD_FILE_VERSION) {
    throw new Unreadable(`its ${FILE} is version ${JSON.stringify(root.version)}, and Modbench reads only version ${BUILD_FILE_VERSION}`);
  }
  known(root, undefined, ['version', 'steps']);
  return { steps: Object.hasOwn(root, 'steps') ? arrayOf(FILE, root.steps, 'its steps').map((line, index) => stepOf(index, line)) : [] };
};

/** `text` read as a build file of version 1, which holds no exclusion: those are the modlist's (mods.md, A source mod, story 2). */
export const readBuildFile = (text: string): BuildFileRead => {
  const read = parsed(text, FILE, buildFileOf);
  return 'refused' in read ? read : { buildFile: read.read };
};
