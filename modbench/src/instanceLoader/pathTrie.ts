import { present } from '../ports/present';

// A hash trie of entries by key. A fork shares every node with its trie, and a change copies only the nodes on its key's
// way down, so it costs the keys it changes, whatever the trie holds.

const BITS = 5;
const WIDTH = 1 << BITS;
const MASK = WIDTH - 1;
// A leaf past this many entries splits, while the hash has bits left to split on.
const LEAF_MOST = 32;
const LAST_SHIFT = 30;

type Node<E> = Map<string, E> | (Node<E> | undefined)[];

// FNV-1a.
function hashOf(key: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < key.length; at++) hash = Math.imul(hash ^ key.charCodeAt(at), 0x01000193);
  return hash >>> 0;
}

export class PathTrie<E> {
  // A branch from the start, so a change copies the same nodes in a small trie as in a large one until a leaf splits.
  private root: Node<E> = Array.from<Node<E> | undefined>({ length: WIDTH });
  // The nodes no other trie shares, which this one changes in place.
  private owned = new WeakSet<Node<E>>([this.root]);

  get(key: string): E | undefined {
    const hash = hashOf(key);
    let node: Node<E> | undefined = this.root;
    for (let shift = 0; Array.isArray(node); shift += BITS) node = node[(hash >>> shift) & MASK];
    return node?.get(key);
  }

  /** Puts `entry` at `key`, or takes the key out where `entry` is undefined. */
  put(key: string, entry: E | undefined): void {
    this.root = present(this.placed(this.root, hashOf(key), 0, key, entry), 'the root');
  }

  /** A trie holding what this one holds. */
  fork(): PathTrie<E> {
    const fork = new PathTrie<E>();
    fork.root = this.root;
    fork.owned = new WeakSet();
    this.owned = new WeakSet();
    return fork;
  }

  * values(): IterableIterator<E> {
    const nodes: (Node<E> | undefined)[] = [this.root];
    while (nodes.length > 0) {
      const node = nodes.pop();
      if (node instanceof Map) yield* node.values();
      else if (node !== undefined) nodes.push(...node);
    }
  }

  private placed(node: Node<E> | undefined, hash: number, shift: number, key: string, entry: E | undefined): Node<E> | undefined {
    if (node === undefined) return entry === undefined ? undefined : this.made(new Map([[key, entry]]));
    if (Array.isArray(node)) {
      const branch = this.owned.has(node) ? node : this.made([...node]);
      const at = (hash >>> shift) & MASK;
      branch[at] = this.placed(branch[at], hash, shift + BITS, key, entry);
      return branch;
    }
    const leaf = this.owned.has(node) ? node : this.made(new Map(node));
    if (entry === undefined) leaf.delete(key);
    else leaf.set(key, entry);
    return leaf.size > LEAF_MOST && shift < LAST_SHIFT ? this.split(leaf, shift) : leaf;
  }

  private split(leaf: Map<string, E>, shift: number): Node<E> {
    const branch = this.made(Array.from<Node<E> | undefined>({ length: WIDTH }));
    for (const [key, entry] of leaf) {
      const hash = hashOf(key);
      const at = (hash >>> shift) & MASK;
      branch[at] = this.placed(branch[at], hash, shift + BITS, key, entry);
    }
    return branch;
  }

  private made<N extends Node<E>>(node: N): N {
    this.owned.add(node);
    return node;
  }
}
