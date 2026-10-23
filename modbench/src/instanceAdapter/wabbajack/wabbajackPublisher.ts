// Wabbajack's implementation of the Instance adapter as a publisher (ADR-0024): the publisher tags
// its compiler settings hold. Its compiler reads them alone once they are there, never a mod's
// metadata (publishing.md, Publisher tags, story 5).

import { join, relative, sep } from 'node:path';
import { errorMessage } from '../../ports/errorMessage';
import { get, readOrAbsent } from '../files';
import type { PublisherConfiguration, PublisherTag } from '../instanceAdapter';
import type { Publisher } from '../publisher';
import { watchFiles } from '../watchFiles';

// Wabbajack's configuration, at the instance root.
const COMPILER_SETTINGS_FILE = 'compiler_settings.json';

// Each publisher tag under the key its paths are listed by, in the order Wabbajack's compiler declares them.
const TAGS: readonly { readonly key: string; readonly tag: PublisherTag }[] = [
  { key: 'NoMatchInclude', tag: { name: 'No Match Include', badge: 'NM', marksPaths: true, shipsDisabledMod: false } },
  { key: 'Include', tag: { name: 'Include', badge: 'IN', marksPaths: true, shipsDisabledMod: false } },
  { key: 'Ignore', tag: { name: 'Ignore', badge: 'IG', marksPaths: true, shipsDisabledMod: false } },
  { key: 'AlwaysEnabled', tag: { name: 'Always Enabled', badge: 'AE', marksPaths: false, shipsDisabledMod: true } },
];

// A path relative to the instance as Wabbajack splits one: at either separator, an empty name dropped,
// each name compared without case.
const namesOf = (path: string): string[] => path.split(/[\\/]/).filter((name) => name !== '').map((name) => name.toLowerCase());

interface PathNode {
  readonly tags: Set<PublisherTag>;
  readonly below: Map<string, PathNode>;
}

const pathNode = (): PathNode => ({ tags: new Set(), below: new Map() });

function settingsIn(text: string, file: string): object {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not JSON: ${errorMessage(err)}`, { cause: err });
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) throw new Error(`${file} holds no settings object`);
  return settings;
}

function tagsByPath(text: string, file: string): PathNode {
  const settings = settingsIn(text, file);
  const root = pathNode();
  for (const { key, tag } of TAGS) {
    const paths: unknown = Object.getOwnPropertyDescriptor(settings, key)?.value ?? [];
    if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string')) throw new Error(`${file}: ${key} is not a list of paths`);
    for (const path of paths) {
      let node = root;
      for (const name of namesOf(path)) {
        const next = node.below.get(name) ?? pathNode();
        node.below.set(name, next);
        node = next;
      }
      node.tags.add(tag);
    }
  }
  return root;
}

// A publisher tag covers the path it names and every path in it.
function coveringIn(instanceRoot: string, root: PathNode): (path: string) => readonly PublisherTag[] {
  return (path) => {
    const inInstance = relative(instanceRoot, path);
    if (inInstance.split(sep)[0] === '..') return [];
    const found = new Set(root.tags);
    let at: PathNode | undefined = root;
    for (const name of namesOf(inInstance)) {
      at = at.below.get(name);
      if (at === undefined) break;
      for (const tag of at.tags) found.add(tag);
    }
    return TAGS.flatMap(({ tag }) => (found.has(tag) ? [tag] : []));
  };
}

export function wabbajackPublisher(instanceRoot: string): Publisher {
  const file = join(instanceRoot, COMPILER_SETTINGS_FILE);
  return {
    tags: TAGS.map(({ tag }) => tag),
    configuration: async (): Promise<PublisherConfiguration> => {
      try {
        const text = await readOrAbsent(() => get(file), undefined);
        return text === undefined ? { kind: 'none' } : { kind: 'read', covering: coveringIn(instanceRoot, tagsByPath(text, file)) };
      } catch (err) {
        return { kind: 'unreadable', reason: errorMessage(err) };
      }
    },
    subscribe: (listener) => watchFiles(instanceRoot, COMPILER_SETTINGS_FILE, () => listener()),
  };
}
