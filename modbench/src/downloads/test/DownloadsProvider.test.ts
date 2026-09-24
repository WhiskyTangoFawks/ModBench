import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, uriFile,
} from '../../test/vscodeMock';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { file: uriFile },
}));

import { DownloadsProvider, DownloadNode, type DownloadsProviderOptions, type DownloadsTreeNode } from '../DownloadsProvider';
import { ErrorNode } from '../errorNode';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { withUnreadCorpusInstance } from '../../test/mo2/unreadCorpusInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import type { DownloadRow } from '../../mo2Codecs/downloads';
import type { DownloadFile, InstanceValue } from '../../instanceLoader/instance';
import { present } from '../../ports/present';

// The narrowing is deliberate: a read-failure row here has no `row`, and the throw is the finding.
const rowNames = (nodes: DownloadsTreeNode[]): string[] => nodes.map((n) => expectInstanceOf(n, DownloadNode).row.name);

// The Instance's own row: the two paths it carries are what a view opens, so the fixture names
// them exactly as a recompute over `/instance` would.
const row = (extra: Partial<DownloadRow> = {}): DownloadFile => {
  const base: DownloadRow = {
    name: 'foo.zip',
    displayName: 'foo.zip',
    status: 'Downloaded',
    size: 100,
    mtimeMs: 1700000000000,
    hasMeta: false,
    hidden: false,
    ...extra,
  };
  return {
    ...base,
    path: join('/instance', 'downloads', base.name),
    sidecarPath: join('/instance', 'downloads', base.name + '.meta'),
  };
};

// Only `.downloads` is ever read by the row provider — the rest of InstanceValue is other
// views' territory this ticket does not touch.
function valueOf(downloads: DownloadFile[]): InstanceValue {
  return instanceValueFixture({ downloads: { kind: 'listed', rows: downloads } });
}

// The double the row provider's own contract needs: `.value` plus `.subscribe`, structurally
// compatible with `Instance` without ever constructing one (ADR-0015's watcher is Instance's
// concern, not this provider's).
class FakeInstance {
  value: InstanceValue;
  // Defaults to 1 ("already loaded") so every existing fixture-based test needs no opinion on
  // it; a test of the sequence === 0 ("not read yet") guard passes 0 explicitly.
  sequence: number;
  readFailure: string | undefined;
  private subscribers: ((value: InstanceValue, sequence: number) => void)[] = [];
  private failureListeners: (() => void)[] = [];
  constructor(initial: InstanceValue, sequence = 1) {
    this.value = initial;
    this.sequence = sequence;
  }
  subscribe(subscriber: (value: InstanceValue, sequence: number) => void) {
    this.subscribers.push(subscriber);
    return { dispose: () => { this.subscribers = this.subscribers.filter((s) => s !== subscriber); } };
  }
  // Simulates a landed recompute: publishes to every live subscriber, the way Instance's own
  // watcher-driven recompute does.
  publish(value: InstanceValue): void {
    this.value = value;
    this.readFailure = undefined;
    this.sequence++;
    for (const subscriber of [...this.subscribers]) subscriber(value, this.sequence);
  }
  onReadFailure(listener: () => void) {
    this.failureListeners.push(listener);
    return { dispose: () => { this.failureListeners = this.failureListeners.filter((l) => l !== listener); } };
  }
  // Simulates a recompute that threw: the value and sequence stay put, and the reason is held.
  fail(reason: string): void {
    this.readFailure = reason;
    for (const listener of [...this.failureListeners]) listener();
  }
}

// A hang must fail on an explicit assertion, not the test runner's own timeout.
const within = <T>(pending: Promise<T>, ms: number): Promise<T> => Promise.race([
  pending,
  new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`getChildren() did not settle within ${ms} ms`)), ms)),
]);

// Never created on disk. If DownloadsProvider ever fell back to its own scan, every test here
// would see an empty/ENOENT result instead of the fixture rows below.
const makeProvider = (
  downloads: DownloadFile[],
  extra: Partial<{ instance: FakeInstance }> = {},
): DownloadsProvider => {
  const instance = extra.instance ?? new FakeInstance(valueOf(downloads));
  const options: DownloadsProviderOptions = { instance };
  return new DownloadsProvider(options);
};

// ── DownloadNode field construction ─────────────────────────────────────────

describe('DownloadNode', () => {
  it('label is the row displayName; id is pinned to the raw filename', () => {
    const node = new DownloadNode(row({ name: 'foo_1_2_3.zip', displayName: 'Sleep or Save' }));
    expect(node.label).toBe('Sleep or Save');
    expect(node.id).toBe('foo_1_2_3.zip');
  });

  it('is a flat leaf row (no children)', () => {
    const node = new DownloadNode(row());
    expect(node.collapsibleState).toBe(0); // TreeItemCollapsibleState.None
  });

  describe('status icon + colour', () => {
    it('Downloaded -> archive icon, green', () => {
      const node = new DownloadNode(row({ status: 'Downloaded' }));
      const icon = expectInstanceOf(node.iconPath, ThemeIcon);
      expect(icon.id).toBe('archive');
      expect(icon.color?.id).toBe('charts.green');
    });

    it('Installed -> check icon, no explicit colour', () => {
      const node = new DownloadNode(row({ status: 'Installed' }));
      const icon = expectInstanceOf(node.iconPath, ThemeIcon);
      expect(icon.id).toBe('check');
      expect(icon.color).toBeUndefined();
    });

    it('Uninstalled -> circle-slash icon, yellow', () => {
      const node = new DownloadNode(row({ status: 'Uninstalled' }));
      const icon = expectInstanceOf(node.iconPath, ThemeIcon);
      expect(icon.id).toBe('circle-slash');
      expect(icon.color?.id).toBe('charts.yellow');
    });
  });

  describe('description', () => {
    it('Downloaded (default) shows only the version, unmarked', () => {
      const node = new DownloadNode(row({ status: 'Downloaded', version: '2.2.1' }));
      expect(node.description).toBe('v2.2.1');
    });

    it('Installed appends the status word after the version', () => {
      const node = new DownloadNode(row({ status: 'Installed', version: '2.2.1' }));
      expect(node.description).toBe('v2.2.1 Installed');
    });

    it('Uninstalled appends the status word after the version', () => {
      const node = new DownloadNode(row({ status: 'Uninstalled', version: '2.2.1' }));
      expect(node.description).toBe('v2.2.1 Uninstalled');
    });

    it('omits the version entirely when absent, leaving just the status word (or nothing)', () => {
      expect(new DownloadNode(row({ status: 'Downloaded' })).description).toBe('');
      expect(new DownloadNode(row({ status: 'Installed' })).description).toBe('Installed');
    });
  });

  describe('tooltip', () => {
    it('a fully-populated row includes every field', () => {
      const node = new DownloadNode(
        row({
          modName: 'Sleep or Save', version: '2.2.1', modID: '12345', size: 4096,
          mtimeMs: Date.parse('2024-01-15T10:00:00Z'), gameName: 'Fallout4', author: 'SomeAuthor',
        }),
      );
      const tooltip = expectInstanceOf(node.tooltip, MarkdownString);
      expect(tooltip.value).toContain('foo.zip');
      expect(tooltip.value).toContain('Sleep or Save');
      expect(tooltip.value).toContain('2.2.1');
      expect(tooltip.value).toContain('12345');
      expect(tooltip.value).toContain('4096');
      expect(tooltip.value).toContain('Fallout4');
      expect(tooltip.value).toContain('SomeAuthor');
    });

    it('a minimal row (filename only) omits every optional field without erroring', () => {
      const node = new DownloadNode(row());
      const tooltip = expectInstanceOf(node.tooltip, MarkdownString);
      expect(tooltip.value).toContain('foo.zip');
      expect(tooltip.value).not.toContain('undefined');
    });
  });

  it('contextValue is the row\'s downloadContextValue', () => {
    const node = new DownloadNode(row({ hasMeta: true, modID: '1', hidden: true }));
    expect(node.contextValue).toBe('download hasModID hasMeta hidden');
  });

  it('resourceUri is the path the value carries for the row', () => {
    const node = new DownloadNode(row({ name: 'foo.zip' }));
    expect(present(node.resourceUri, "the download node's resourceUri").fsPath).toBe(join('/instance', 'downloads', 'foo.zip'));
  });

  it('exposes the source row for command handlers to act on', () => {
    const r = row();
    expect(new DownloadNode(r).row).toBe(r);
  });
});

// ── DownloadsProvider — rows come from the Instance value ──────────────────

describe('DownloadsProvider — rows come from the Instance value', () => {
  it('builds one node per Instance row, default-sorted filetime descending', async () => {
    const provider = makeProvider([
      row({ name: 'old.zip', mtimeMs: 1000 }),
      row({ name: 'new.zip', mtimeMs: 2000 }),
    ]);
    expect(rowNames(await provider.getChildren())).toEqual(['new.zip', 'old.zip']);
  });

  it('narrows to rows whose label contains the filter text, case-insensitively', async () => {
    const provider = makeProvider([
      row({ name: 'ArmorPack.zip', displayName: 'ArmorPack.zip' }),
      row({ name: 'WeaponPack.zip', displayName: 'WeaponPack.zip' }),
    ]);
    await provider.getChildren();
    provider.setFilter('armor');

    expect(rowNames(await provider.getChildren())).toEqual(['ArmorPack.zip']);
  });

  // downloads.md, story 4 and common.md, The name filter, story 2: the filter matches the label.
  // The file name below has no "armor" in it, so matching on `name` would drop this row.
  it('narrows by the label, not the raw filename', async () => {
    const provider = makeProvider([
      row({ name: 'file-one.zip', displayName: 'Armor Pack' }),
      row({ name: 'file-two.zip', displayName: 'Weapon Pack' }),
    ]);
    await provider.getChildren();
    provider.setFilter('armor');

    expect(rowNames(await provider.getChildren())).toEqual(['file-one.zip']);
  });

  // The filter is render-only: it narrows already-built rows and never re-pulls the Instance
  // value, so clearing it must show the stale cache, not a fresh read.
  it('restores the cached rows when the filter is cleared, without re-pulling the Instance value', async () => {
    const instance = new FakeInstance(valueOf([
      row({ name: 'ArmorPack.zip', displayName: 'ArmorPack.zip' }),
      row({ name: 'WeaponPack.zip', displayName: 'WeaponPack.zip' }),
    ]));
    const provider = makeProvider([], { instance });
    await provider.getChildren();
    provider.setFilter('armor');
    await provider.getChildren();

    instance.value = valueOf([row({ name: 'ArmorPack.zip', displayName: 'ArmorPack.zip' })]); // no publish(), no invalidate()
    provider.setFilter('');

    expect(rowNames(await provider.getChildren()).sort()).toEqual(['ArmorPack.zip', 'WeaponPack.zip']);
  });

  it('excludes hidden rows by default (Show hidden off)', async () => {
    const provider = makeProvider([row({ name: 'hidden.zip', hidden: true }), row({ name: 'visible.zip' })]);
    expect(rowNames(await provider.getChildren())).toEqual(['visible.zip']);
  });

  it('returns no children when the Instance value has no downloads', async () => {
    const provider = makeProvider([]);
    expect(await provider.getChildren()).toEqual([]);
  });

  it('a non-root element (a download row) has no children of its own', async () => {
    const provider = makeProvider([row({ name: 'foo.zip' })]);
    const [node] = await provider.getChildren();
    expect(await provider.getChildren(node)).toEqual([]);
  });
});

// downloads.md, "Which files are rows", story 2: only the files install can take are rows, by
// install's own extension list.
describe('DownloadsProvider — only the files install can take are rows', () => {
  // The view's own filter, defense in depth beside buildDownloadRows already folding a sidecar
  // into its file's row rather than giving it one of its own.
  it('keeps the archive; a readme, a subfolder, an .unfinished file and a stray .meta are not rows', async () => {
    const provider = makeProvider([
      row({ name: 'ArmorPack-1-0.zip' }),
      row({ name: 'ReadMe.txt' }),
      row({ name: 'Textures' }), // a subfolder: no extension of its own
      row({ name: 'ArmorPack-1-0.rar.unfinished' }),
      row({ name: 'ArmorPack-1-0.zip.meta' }),
    ]);
    expect(rowNames(await provider.getChildren())).toEqual(['ArmorPack-1-0.zip']);
  });

  it('compares the extension case-insensitively', async () => {
    const provider = makeProvider([row({ name: 'ArmorPack-1-0.ZIP' })]);
    expect(rowNames(await provider.getChildren())).toEqual(['ArmorPack-1-0.ZIP']);
  });

  it('keeps every extension install can extract', async () => {
    const provider = makeProvider([
      row({ name: 'a.zip' }), row({ name: 'b.7z' }), row({ name: 'c.rar' }),
    ]);
    expect(rowNames(await provider.getChildren()).sort()).toEqual(['a.zip', 'b.7z', 'c.rar'].sort());
  });
});

describe('setShowHidden', () => {
  it('includes hidden rows alongside visible ones when turned on', async () => {
    const provider = makeProvider([row({ name: 'hidden.zip', hidden: true }), row({ name: 'visible.zip' })]);
    provider.setShowHidden(true);
    expect(rowNames(await provider.getChildren()).sort()).toEqual(['hidden.zip', 'visible.zip']);
  });

  it('excludes hidden rows again once turned back off', async () => {
    const provider = makeProvider([row({ name: 'hidden.zip', hidden: true }), row({ name: 'visible.zip' })]);
    provider.setShowHidden(true);
    await provider.getChildren();
    provider.setShowHidden(false);
    expect(rowNames(await provider.getChildren())).toEqual(['visible.zip']);
  });

  it('re-renders: fires onDidChangeTreeData', async () => {
    const provider = makeProvider([]);
    await provider.getChildren();
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.setShowHidden(true);
    expect(fired).toBe(true);
  });
});

describe('setSort', () => {
  it('re-sorts by name ascending, overriding the default Filetime-descending order', async () => {
    const provider = makeProvider([
      row({ name: 'banana.zip', displayName: 'banana.zip' }),
      row({ name: 'apple.zip', displayName: 'apple.zip' }),
    ]);
    provider.setSort('name', false);
    expect(rowNames(await provider.getChildren())).toEqual(['apple.zip', 'banana.zip']);
  });

  // The file names sort opposite the labels, so a sort keyed on `name` instead of `displayName`
  // returns the wrong order.
  it('sorts by the label, not the raw filename', async () => {
    const provider = makeProvider([
      row({ name: 'z-file.zip', displayName: 'Apple' }),
      row({ name: 'a-file.zip', displayName: 'Banana' }),
    ]);
    provider.setSort('name', false);
    expect(rowNames(await provider.getChildren())).toEqual(['z-file.zip', 'a-file.zip']);
  });

  it('re-renders: fires onDidChangeTreeData', async () => {
    const provider = makeProvider([]);
    await provider.getChildren();
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.setSort('name', false);
    expect(fired).toBe(true);
  });
});

// downloads.md, Order and view state, story 2: "The pick marks the current sort." The sort
// command reads this to pre-select its active item.
describe('currentSort', () => {
  it('starts at the spec default: Filetime, descending', () => {
    expect(makeProvider([]).currentSort()).toEqual({ column: 'mtimeMs', descending: true });
  });

  it('reflects the last setSort call', () => {
    const provider = makeProvider([]);
    provider.setSort('name', false);
    expect(provider.currentSort()).toEqual({ column: 'name', descending: false });
  });
});

// downloads.md, States, story 2: distinct from "no downloads yet" — files exist, but every one
// is currently hidden by Show excluded being off.
describe('allExcluded', () => {
  it('is false with no downloads at all', () => {
    expect(makeProvider([]).allExcluded()).toBe(false);
  });

  it('is false when at least one row is not excluded', () => {
    const provider = makeProvider([row({ name: 'hidden.zip', hidden: true }), row({ name: 'visible.zip' })]);
    expect(provider.allExcluded()).toBe(false);
  });

  it('is true when every row is excluded and Show excluded is off', () => {
    const provider = makeProvider([row({ name: 'a.zip', hidden: true }), row({ name: 'b.zip', hidden: true })]);
    expect(provider.allExcluded()).toBe(true);
  });

  it('is false once Show excluded is turned on, even with every row excluded', () => {
    const provider = makeProvider([row({ name: 'a.zip', hidden: true }), row({ name: 'b.zip', hidden: true })]);
    provider.setShowHidden(true);
    expect(provider.allExcluded()).toBe(false);
  });

  it('ignores a non-archive file when deciding whether every archive is excluded', () => {
    const provider = makeProvider([row({ name: 'readme.txt', hidden: false })]);
    expect(provider.allExcluded()).toBe(false);
  });
});

describe('excludedNames', () => {
  it('is empty before any render', () => {
    expect(makeProvider([]).excludedNames()).toEqual(new Set());
  });

  it('is empty while Show hidden is off, even with excluded rows in the value', async () => {
    const provider = makeProvider([row({ name: 'hidden.zip', hidden: true })]);
    await provider.getChildren();
    expect(provider.excludedNames()).toEqual(new Set());
  });

  it('lists excluded row names once Show hidden is on and the tree has rendered', async () => {
    const provider = makeProvider([row({ name: 'hidden.zip', hidden: true }), row({ name: 'visible.zip' })]);
    provider.setShowHidden(true);
    await provider.getChildren();
    expect(provider.excludedNames()).toEqual(new Set(['hidden.zip']));
  });
});

describe('invalidate', () => {
  it('clears the cache, re-pulls the current Instance value, and fires onDidChangeTreeData', async () => {
    const instance = new FakeInstance(valueOf([row({ name: 'old.zip' })]));
    const provider = makeProvider([], { instance });
    expect(rowNames(await provider.getChildren())).toEqual(['old.zip']);

    instance.value = valueOf([row({ name: 'old.zip' }), row({ name: 'new.zip' })]); // no publish()
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.invalidate();

    expect(fired).toBe(true);
    expect(rowNames(await provider.getChildren()).sort()).toEqual(['new.zip', 'old.zip']);
  });
});

// ── DownloadsProvider — the Instance is the only way in ────────────────────

describe('DownloadsProvider — reacts to the Instance, never scans on its own', () => {
  // The empty value before the first read is "not read yet", never "no downloads": a render asked
  // for before the read, and awaited after it, shows the rows that read lands.
  it('renders no rows before the first read, and the read\'s rows once it lands', async () => {
    await withUnreadCorpusInstance(async (instance) => {
      const provider = new DownloadsProvider({ instance });

      const pending = provider.getChildren();
      await instance.refresh();

      expect(rowNames(await pending)).toEqual(['Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z']);
      provider.dispose();
    });
  });

  // The timeout is the finding: a gate that settles only on a landed value leaves a first read
  // that threw spinning forever (ADR-0019).
  it('settles a failed first read on the one error row naming the reason, then renders rows when a value lands', async () => {
    const instance = new FakeInstance(valueOf([]), 0);
    const provider = makeProvider([], { instance });

    const pending = provider.getChildren();
    instance.fail('ENOENT: no such file or directory, open modlist.txt');
    const rows = await within(pending, 500);

    expect(rows).toHaveLength(1);
    const error = expectInstanceOf(rows[0], ErrorNode);
    expect(error.label).toBe('Failed to load: ENOENT: no such file or directory, open modlist.txt');
    expect(error.tooltip).toBe('ENOENT: no such file or directory, open modlist.txt');
    expect(error.iconPath).toEqual(new ThemeIcon('error'));

    instance.publish(valueOf([row({ name: 'a.zip' })]));
    const after = await within(provider.getChildren(), 500);

    expect(rowNames(after)).toEqual(['a.zip']);
  });

  it('renders no rows immediately when the first landed value is genuinely empty', async () => {
    const provider = makeProvider([], { instance: new FakeInstance(valueOf([]), 1) });
    expect(await provider.getChildren()).toEqual([]);
  });

  // Guards against a provider that subscribes but drops the callback: a first-render-only
  // assertion would pass that rival, so this renders once, waits a macrotask past a second
  // landed value, and only then re-reads.
  it('re-renders when the Instance publishes a new landed value, past a macrotask boundary', async () => {
    const instance = new FakeInstance(valueOf([row({ name: 'a.zip' })]));
    const provider = makeProvider([], { instance });
    expect(rowNames(await provider.getChildren())).toEqual(['a.zip']);

    instance.publish(valueOf([row({ name: 'a.zip' }), row({ name: 'b.zip' })]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rowNames(await provider.getChildren()).sort()).toEqual(['a.zip', 'b.zip']);
  });

  it('dispose() disposes the Instance subscription: a publish afterward leaves the cache untouched', async () => {
    const instance = new FakeInstance(valueOf([row({ name: 'a.zip' })]));
    const provider = makeProvider([], { instance });
    await provider.getChildren();

    provider.dispose();
    instance.publish(valueOf([row({ name: 'a.zip' }), row({ name: 'b.zip' })]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rowNames(await provider.getChildren())).toEqual(['a.zip']);
  });

  // The provider is never told where the instance is, so a scan of its own has nothing to walk:
  // every row, and every path on one, arrives in the value.
  it('never touches disk: it is given no instance root to walk', async () => {
    const provider = makeProvider([row({ name: 'a.zip' })]);
    expect(rowNames(await provider.getChildren())).toEqual(['a.zip']);
  });

  it('a file appearing on disk changes nothing until the Instance publishes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'downloads-provider-'));
    try {
      const instance = new FakeInstance(valueOf([row({ name: 'a.zip' })]));
      const provider = makeProvider([], { instance });
      expect(rowNames(await provider.getChildren())).toEqual(['a.zip']);

      await writeFile(join(root, 'b.zip'), 'data'); // never reaches the Instance in this test

      expect(rowNames(await provider.getChildren())).toEqual(['a.zip']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// A folder Modbench cannot resolve is not the folder MO2 names (downloads.md, story 1): the shared
// "Failed to load:" state (common.md, States, story 2), scoped to this view alone.
describe('DownloadsProvider — the configured downloads folder could not be resolved', () => {
  const REASON = 'download_directory "D:\\Games\\downloads" could not be resolved: '
    + "Cannot translate Wine drive letter 'D:' in 'D:\\Games\\downloads': only Z: and C: are translated";
  const unresolvedValue = () => instanceValueFixture({ downloads: { kind: 'unresolved', reason: REASON } });

  it('renders one error row naming the reason, even though the instance read itself landed', async () => {
    const provider = makeProvider([], { instance: new FakeInstance(unresolvedValue(), 1) });

    const rows = await provider.getChildren();

    expect(rows).toHaveLength(1);
    const error = expectInstanceOf(rows[0], ErrorNode);
    expect(error.label).toBe(`Failed to load: ${REASON}`);
    expect(error.tooltip).toBe(REASON);
  });

  // Rival: the row provider falling back to whatever rows happened to be cached or the value
  // otherwise carries, rather than the dedicated unresolved state.
  it('never renders a download row while unresolved, whatever rows a stale cache might hold', async () => {
    const instance = new FakeInstance(valueOf([row({ name: 'a.zip' })]));
    const provider = makeProvider([], { instance });
    await provider.getChildren(); // caches the 'a.zip' row

    instance.publish(unresolvedValue());
    const rows = await provider.getChildren();

    expect(rows).toHaveLength(1);
    expectInstanceOf(rows[0], ErrorNode);
  });

  it('allExcluded is false while unresolved — there are no rows to be all-excluded', () => {
    const provider = makeProvider([], { instance: new FakeInstance(unresolvedValue(), 1) });
    expect(provider.allExcluded()).toBe(false);
  });

  it('renders rows again once a later recompute resolves the folder', async () => {
    const instance = new FakeInstance(unresolvedValue(), 1);
    const provider = makeProvider([], { instance });
    expect(await provider.getChildren()).toHaveLength(1); // the error row

    instance.publish(valueOf([row({ name: 'a.zip' })]));

    expect(rowNames(await provider.getChildren())).toEqual(['a.zip']);
  });
});
