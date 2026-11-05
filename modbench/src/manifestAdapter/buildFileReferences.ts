import { findNodeAtOffset, getNodePath, parseTree, type Node } from 'jsonc-parser';
import { errorMessage } from '../ports/errorMessage';
import { placeIn, type SymbolOwner, type SymbolReading } from '../symbolNames/symbolNames';
import { readBuildFile } from './buildFileRead';
import { buildFileTextIn } from './manifestFiles';

interface NameInText {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

// The steps whose paths name a plugin when they name a file at the root.
const NAMING_PLUGINS: readonly unknown[] = ['decompile', 'compile', 'copy'];

function isPluginAtTheRoot(node: Node): boolean {
  if (node.type !== 'string' || typeof node.value !== 'string' || node.value.includes('/')) return false;
  const [steps, , kind, at] = getNodePath(node);
  return steps === 'steps' && NAMING_PLUGINS.includes(kind) && typeof at === 'number';
}

const nameOf = (node: Node): NameInText => ({ name: String(node.value), start: node.offset + 1, end: node.offset + node.length - 1 });

function pluginNodes(node: Node | undefined): Node[] {
  if (node === undefined) return [];
  return isPluginAtTheRoot(node) ? [node] : (node.children ?? []).flatMap(pluginNodes);
}

/** The plugin a build file's step names at `offset` of its text, with the span of its name. */
export function buildFilePluginAt(text: string, offset: number): NameInText | undefined {
  const root = parseTree(text);
  const node = root && findNodeAtOffset(root, offset);
  return node && isPluginAtTheRoot(node) ? nameOf(node) : undefined;
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const NONE: SymbolReading = { references: [], leftOut: [] };

const leftOut = (file: string, why: string): SymbolReading => ({ references: [], leftOut: [`${file}: ${why}`] });

/** The build files as an owner of files that name a plugin: each source mod's names the plugins of that mod.
 *  `sourceFolders`: each source mod's source folder, by mod. */
export function buildFileReferences(sourceFolders: () => ReadonlyMap<string, string>): SymbolOwner {
  return {
    async read({ name, origin }, held) {
      const [mod, folder] = [...sourceFolders()].find(([named]) => sameName(named, origin)) ?? [];
      if (mod === undefined || folder === undefined) return NONE;
      try {
        const at = await buildFileTextIn(folder, held);
        if (at === undefined) return NONE;
        if ('refused' in at) return leftOut(at.file, at.refused);
        const read = readBuildFile(at.text);
        if ('refused' in read) return leftOut(at.file, read.refused);
        const named = pluginNodes(parseTree(at.text)).map(nameOf).filter((found) => sameName(found.name, name));
        return { references: named.map(({ name: spelled, start, end }) => ({ place: placeIn(at.file, at.text, start, end), names: { name: spelled, origin: mod } })), leftOut: [] };
      } catch (err) {
        return leftOut(folder, errorMessage(err));
      }
    },
  };
}
