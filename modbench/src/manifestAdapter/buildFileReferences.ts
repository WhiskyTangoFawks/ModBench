import { basename, dirname } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import { placeIn, sameName, samePath, type SymbolOwner, type SymbolReading } from '../symbolNames/symbolNames';
import { readBuildFile } from './buildFileRead';
import { buildFileTextIn, isBuildFileName } from './manifestFiles';

interface NameInText {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

type Segment = string | number;

interface StringAt extends NameInText {
  readonly path: readonly Segment[];
}

const WHITESPACE = /\s/;
const SCALAR_END = /[\s,\]}]/;

// Each string value of `text`, a JSON text the build file's read accepted, with its path and the span of its value.
function stringsOf(text: string): StringAt[] {
  const found: StringAt[] = [];
  let at = 0;
  const skipWhitespace = (): void => { while (WHITESPACE.test(text.charAt(at))) at += 1; };
  const string = (): NameInText => {
    const start = at;
    at += 1;
    while (text.charAt(at) !== '"') at += text.charAt(at) === '\\' ? 2 : 1;
    at += 1;
    const name: unknown = JSON.parse(text.slice(start, at));
    return { name: String(name), start: start + 1, end: at - 1 };
  };
  const items = (close: string, item: (index: number) => void): void => {
    at += 1;
    skipWhitespace();
    for (let index = 0; text.charAt(at) !== close; index += 1) {
      item(index);
      skipWhitespace();
      if (text.charAt(at) === ',') at += 1;
      skipWhitespace();
    }
    at += 1;
  };
  const value = (path: readonly Segment[]): void => {
    skipWhitespace();
    const opening = text.charAt(at);
    if (opening === '"') found.push({ ...string(), path });
    else if (opening === '{') items('}', () => { const key = string().name; skipWhitespace(); at += 1; value([...path, key]); });
    else if (opening === '[') items(']', (index) => { value([...path, index]); });
    else while (at < text.length && !SCALAR_END.test(text.charAt(at))) at += 1;
  };
  value([]);
  return found;
}

// The paths of the steps that name a file of the source folder, or one an archive holds: a plugin, at the root.
const isNamingAFile = ([steps, , kind, ...rest]: readonly Segment[]): boolean =>
  steps === 'steps' && (kind === 'unpack' ? rest.length === 2 : ['decompile', 'compile', 'copy'].includes(String(kind)) && rest.length === 1);

const isPluginAtTheRoot = ({ name, path }: StringAt): boolean => isNamingAFile(path) && typeof path.at(-1) === 'number' && !name.includes('/');

function pluginsIn(text: string): readonly NameInText[] | { readonly refused: string } {
  const read = readBuildFile(text);
  return 'refused' in read ? read : stringsOf(text).filter(isPluginAtTheRoot).map(({ name, start, end }) => ({ name, start, end }));
}

const NONE: SymbolReading = { references: [], leftOut: [] };

const leftOut = (file: string, why: string): SymbolReading => ({ references: [], leftOut: [`${file}: ${why}`] });

/** The build files as an owner of files that name a plugin: each source mod's names the plugins of that mod.
 *  `sourceFolders`: each source mod's source folder, by mod. */
export function buildFileReferences(sourceFolders: () => ReadonlyMap<string, string>): SymbolOwner {
  return {
    nameAt(file, text, offset) {
      const [mod] = [...sourceFolders()].find(([, folder]) => samePath(dirname(file), folder) && isBuildFileName(basename(file))) ?? [];
      const plugins = mod === undefined ? [] : pluginsIn(text);
      const named = 'refused' in plugins ? undefined : plugins.find(({ start, end }) => offset >= start && offset <= end);
      return Promise.resolve(named && mod !== undefined ? { name: named.name, origin: mod } : undefined);
    },
    async read({ name, origin }, held) {
      const [mod, folder] = [...sourceFolders()].find(([named]) => sameName(named, origin)) ?? [];
      if (mod === undefined || folder === undefined) return NONE;
      try {
        const at = await buildFileTextIn(folder, held);
        if (at === undefined) return NONE;
        if ('refused' in at) return leftOut(at.file, at.refused);
        const plugins = pluginsIn(at.text);
        if ('refused' in plugins) return leftOut(at.file, plugins.refused);
        const named = plugins.filter((found) => sameName(found.name, name));
        return { references: named.map(({ name: spelled, start, end }) => ({ place: placeIn(at.file, at.text, start, end), names: { name: spelled, origin: mod } })), leftOut: [] };
      } catch (err) {
        return leftOut(folder, errorMessage(err));
      }
    },
  };
}
