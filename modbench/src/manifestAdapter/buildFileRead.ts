// spec/formats/build-file-1.schema.json, read from any text the schema accepts.

import { BUILD_FILE_VERSION, type BuildFile, type BuildFileRead, type ManifestArchive, type ManifestStep } from './buildFile';
import { arrayOf, isObject, isPathInTheFolder, known as knownIn, objectOf, parsed, required, stringsOf, textOf, unreadable, Unreadable, type Json } from './jsonRead';

const FILE = 'build file';

const known = (members: Json, part: string | undefined, keys: readonly string[]): void => { knownIn(FILE, members, part, keys); };

const inTheFolder = (key: string, paths: readonly string[]): void => {
  const outside = paths.find((path) => !isPathInTheFolder(path));
  if (outside !== undefined) throw new Unreadable(`its ${FILE}'s '${key}' names '${outside}', which is not a path in the folder`);
};

const stepOf = (index: number, line: unknown): ManifestStep => {
  const where = `its step ${index + 1}`;
  const members = objectOf(FILE, line, where);
  known(members, `step ${index + 1}`, ['task', 'args', 'page']);
  const task = textOf(FILE, required(FILE, members, 'task', where), where);
  if (task.trim() === '') throw unreadable(FILE, where, 'it names no task');
  const args = Object.hasOwn(members, 'args') ? stringsOf(FILE, members.args, where) : [];
  if (!Object.hasOwn(members, 'page')) return { task, args };
  const page = textOf(FILE, members.page, where);
  if (!URL.canParse(page)) throw unreadable(FILE, where, 'its page is not a URI');
  return { task, args, page };
};

const archivesOf = (value: unknown): ManifestArchive[] => {
  const archives = Object.entries(objectOf(FILE, value, 'its archives')).map(([path, files]) => ({ path, files: stringsOf(FILE, files, 'its archives') }));
  inTheFolder('archives', [...archives.map((archive) => archive.path), ...archives.flatMap((archive) => archive.files)]);
  const packedBy = new Map<string, { readonly archive: string; readonly file: string }>();
  for (const { path: archive, files } of archives) {
    for (const file of files) {
      const other = packedBy.get(file.toLowerCase());
      if (other?.archive === archive) {
        const same = other.file === file ? `twice in '${archive}'` : `as '${other.file}' and '${file}' in '${archive}', which differ only by case`;
        throw new Unreadable(`its ${FILE}'s 'archives' names '${file}' ${same}`);
      }
      if (other !== undefined) throw new Unreadable(`its ${FILE}'s 'archives' names '${file}' in both '${other.archive}' and '${archive}'`);
      packedBy.set(file.toLowerCase(), { archive, file });
    }
  }
  return archives;
};

const buildFileOf = (value: unknown): BuildFile => {
  if (isObject(value) && !Object.hasOwn(value, 'version')) {
    throw new Unreadable(`its ${FILE} is in a format before version ${BUILD_FILE_VERSION}, and Modbench reads only version ${BUILD_FILE_VERSION}`);
  }
  const root = objectOf(FILE, value, '');
  if (root.version !== BUILD_FILE_VERSION) {
    throw new Unreadable(`its ${FILE} is version ${JSON.stringify(root.version)}, and Modbench reads only version ${BUILD_FILE_VERSION}`);
  }
  known(root, undefined, ['version', 'steps', 'archives']);
  return {
    steps: Object.hasOwn(root, 'steps') ? arrayOf(FILE, root.steps, 'its steps').map((line, index) => stepOf(index, line)) : [],
    archives: Object.hasOwn(root, 'archives') ? archivesOf(root.archives) : [],
  };
};

/** `text` read as a build file of version 1, which holds no exclusion: those are the modlist's (mods.md, A source mod, story 2). */
export const readBuildFile = (text: string): BuildFileRead => {
  const read = parsed(text, FILE, buildFileOf);
  return 'refused' in read ? read : { buildFile: read.read };
};
