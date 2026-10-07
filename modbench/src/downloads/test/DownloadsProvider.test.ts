import { describe, it, expect, vi } from 'vitest';
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

import { DownloadsProvider, DownloadNode, type DownloadsTreeNode } from '../DownloadsProvider';
import { ErrorNode } from '../../drivingLib/errorNode';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { downloadRowFixture } from '../../test/mo2/downloadRowFixture';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import type { DownloadFile, DownloadRow, InstanceValue } from '../../instanceLoader/instance';
import { present } from '../../ports/present';

const rowNamesOfDownloadNodes = (nodes: DownloadsTreeNode[]): string[] => nodes.map((n) => expectInstanceOf(n, DownloadNode).row.name);

const row = (extra: Partial<DownloadRow> = {}): DownloadFile => downloadRowFixture(extra.name ?? 'foo.zip', extra);

function valueOf(downloads: DownloadFile[]): InstanceValue {
  return instanceValueFixture({ downloads: { kind: 'listed', rows: downloads } });
}

const SEQUENCE_NOT_READ_YET = 0;

const explicitFailureIfNotSettledWithin = <T>(pending: Promise<T>, ms: number): Promise<T> => Promise.race([
  pending,
  new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`getChildren() did not settle within ${ms} ms`)), ms)),
]);

const makeProviderOverRowsNeverOnDisk = (
  downloads: DownloadFile[],
  extra: Partial<{ instance: FakeInstance }> = {},
): DownloadsProvider => {
  const instance = extra.instance ?? new FakeInstance(valueOf(downloads));
  const options: ConstructorParameters<typeof DownloadsProvider>[0] = { instance };
  return new DownloadsProvider(options);
};

describe('DownloadNode', () => {
  it('label is the row displayName; id is pinned to the raw filename', () => {
    const node = new DownloadNode(row({ name: 'foo_1_2_3.zip', displayName: 'Sleep or Save' }));
    expect(node.label).toBe('Sleep or Save');
    expect(node.id).toBe('foo_1_2_3.zip');
  });

  it('is a flat leaf row (no children)', () => {
    const node = new DownloadNode(row());
    expect(node.collapsibleState).toBe(TreeItemCollapsibleState.None);
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
    const node = new DownloadNode(row({ hasMeta: true, modID: '1', excluded: true }));
    expect(node.contextValue).toBe('download hasModID hasMeta excluded');
  });

  it('resourceUri is the path the value carries for the row', () => {
    const node = new DownloadNode(row({ name: 'foo.zip' }));
    expect(present(node.resourceUri, "the download node's resourceUri").fsPath).toBe(join('/instance', 'downloads', 'foo.zip'));
  });

  it('exposes the source row for command handlers to act on', () => {
    const r = row();
    expect(new DownloadNode(r).row).toBe(r);
  });

  it('carries its sidecar\'s modID as the Nexus mod id view on Nexus opens, and none without one', () => {
    expect(new DownloadNode(row({ modID: '123' })).nexusModId).toBe('123');
    expect(new DownloadNode(row()).nexusModId).toBeUndefined();
  });
});

describe('DownloadsProvider — rows come from the Instance value', () => {
  it('builds one node per Instance row, default-sorted filetime descending', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([
      row({ name: 'old.zip', mtimeMs: 1000 }),
      row({ name: 'new.zip', mtimeMs: 2000 }),
    ]);
    expect(rowNamesOfDownloadNodes(await provider.getChildren())).toEqual(['new.zip', 'old.zip']);
  });

  it('narrows to rows whose label contains the filter text, case-insensitively', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([
      row({ name: 'ArmorPack.zip', displayName: 'ArmorPack.zip' }),
      row({ name: 'WeaponPack.zip', displayName: 'WeaponPack.zip' }),
    ]);
    await provider.getChildren();
    provider.setFilter('armor');

    expect(rowNamesOfDownloadNodes(await provider.getChildren())).toEqual(['ArmorPack.zip']);
  });

  it('narrows by the label, not the raw filename, which has no "armor" in it', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([
      row({ name: 'file-one.zip', displayName: 'Armor Pack' }),
      row({ name: 'file-two.zip', displayName: 'Weapon Pack' }),
    ]);
    await provider.getChildren();
    provider.setFilter('armor');

    expect(rowNamesOfDownloadNodes(await provider.getChildren())).toEqual(['file-one.zip']);
  });

  it('excludes excluded rows by default (Show excluded off)', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([row({ name: 'excluded.zip', excluded: true }), row({ name: 'visible.zip' })]);
    expect(rowNamesOfDownloadNodes(await provider.getChildren())).toEqual(['visible.zip']);
  });

  it('returns no children when the Instance value has no downloads', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([]);
    expect(await provider.getChildren()).toEqual([]);
  });

  it('a non-root element (a download row) has no children of its own', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([row({ name: 'foo.zip' })]);
    const [node] = await provider.getChildren();
    expect(await provider.getChildren(node)).toEqual([]);
  });
});

describe('DownloadsProvider — only the files install can take are rows', () => {
  it('keeps the archive and drops a listed readme, subfolder, .unfinished file and stray .meta', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([
      row({ name: 'ArmorPack-1-0.zip' }),
      row({ name: 'ReadMe.txt' }),
      row({ name: 'Textures' }),
      row({ name: 'ArmorPack-1-0.rar.unfinished' }),
      row({ name: 'ArmorPack-1-0.zip.meta' }),
    ]);
    expect(rowNamesOfDownloadNodes(await provider.getChildren())).toEqual(['ArmorPack-1-0.zip']);
  });

  it('compares the extension case-insensitively', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([row({ name: 'ArmorPack-1-0.ZIP' })]);
    expect(rowNamesOfDownloadNodes(await provider.getChildren())).toEqual(['ArmorPack-1-0.ZIP']);
  });

  it('keeps every extension install can extract', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([
      row({ name: 'a.zip' }), row({ name: 'b.7z' }), row({ name: 'c.rar' }),
    ]);
    expect(rowNamesOfDownloadNodes(await provider.getChildren()).sort()).toEqual(['a.zip', 'b.7z', 'c.rar'].sort());
  });
});

describe('setShowExcluded', () => {
  it('includes excluded rows alongside visible ones when turned on', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([row({ name: 'excluded.zip', excluded: true }), row({ name: 'visible.zip' })]);
    provider.setShowExcluded(true);
    const nodes = await provider.getChildren();
    expect(rowNamesOfDownloadNodes(nodes).sort()).toEqual(['excluded.zip', 'visible.zip']);
    expect(nodes.map((n) => expectInstanceOf(n, DownloadNode).row).find((r) => r.name === 'excluded.zip')?.excluded).toBe(true);
  });

  it('excludes excluded rows again once turned back off', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([row({ name: 'excluded.zip', excluded: true }), row({ name: 'visible.zip' })]);
    provider.setShowExcluded(true);
    await provider.getChildren();
    provider.setShowExcluded(false);
    expect(rowNamesOfDownloadNodes(await provider.getChildren())).toEqual(['visible.zip']);
  });

  it('re-renders: fires onDidChangeTreeData', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([]);
    await provider.getChildren();
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.setShowExcluded(true);
    expect(fired).toBe(true);
  });
});

describe('setSort', () => {
  it('re-sorts by name ascending, overriding the default Filetime-descending order', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([
      row({ name: 'banana.zip', displayName: 'banana.zip' }),
      row({ name: 'apple.zip', displayName: 'apple.zip' }),
    ]);
    provider.setSort('name', false);
    expect(rowNamesOfDownloadNodes(await provider.getChildren())).toEqual(['apple.zip', 'banana.zip']);
  });

  it('re-renders: fires onDidChangeTreeData', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([]);
    await provider.getChildren();
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.setSort('name', false);
    expect(fired).toBe(true);
  });
});

describe('currentSort', () => {
  it('starts at the spec default: Filetime, descending', () => {
    expect(makeProviderOverRowsNeverOnDisk([]).currentSort()).toEqual({ column: 'mtimeMs', descending: true });
  });

  it('reflects the last setSort call', () => {
    const provider = makeProviderOverRowsNeverOnDisk([]);
    provider.setSort('name', false);
    expect(provider.currentSort()).toEqual({ column: 'name', descending: false });
  });
});

describe('allExcluded, distinct from no downloads: files exist but every one is hidden by Show excluded being off', () => {
  it('is false with no downloads at all', () => {
    expect(makeProviderOverRowsNeverOnDisk([]).allExcluded()).toBe(false);
  });

  it('is false when at least one row is not excluded', () => {
    const provider = makeProviderOverRowsNeverOnDisk([row({ name: 'excluded.zip', excluded: true }), row({ name: 'visible.zip' })]);
    expect(provider.allExcluded()).toBe(false);
  });

  it('is true when every row is excluded and Show excluded is off', () => {
    const provider = makeProviderOverRowsNeverOnDisk([row({ name: 'a.zip', excluded: true }), row({ name: 'b.zip', excluded: true })]);
    expect(provider.allExcluded()).toBe(true);
  });

  it('is false once Show excluded is turned on, even with every row excluded', () => {
    const provider = makeProviderOverRowsNeverOnDisk([row({ name: 'a.zip', excluded: true }), row({ name: 'b.zip', excluded: true })]);
    provider.setShowExcluded(true);
    expect(provider.allExcluded()).toBe(false);
  });

  it('ignores a non-archive file when deciding whether every archive is excluded', () => {
    const provider = makeProviderOverRowsNeverOnDisk([row({ name: 'readme.txt', excluded: false })]);
    expect(provider.allExcluded()).toBe(false);
  });
});

describe('excludedNames', () => {
  it('is empty before any render', () => {
    expect(makeProviderOverRowsNeverOnDisk([]).excludedNames()).toEqual(new Set());
  });

  it('is empty while Show excluded is off, even with excluded rows in the value', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([row({ name: 'excluded.zip', excluded: true })]);
    await provider.getChildren();
    expect(provider.excludedNames()).toEqual(new Set());
  });

  it('lists excluded row names once Show excluded is on and the tree has rendered', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([row({ name: 'excluded.zip', excluded: true }), row({ name: 'visible.zip' })]);
    provider.setShowExcluded(true);
    await provider.getChildren();
    expect(provider.excludedNames()).toEqual(new Set(['excluded.zip']));
  });
});

describe('DownloadsProvider — reacts to the Instance, never scans on its own', () => {
  it('says it shows the last good read, with the reason, when a later read fails, and not once a read lands', () => {
    const instance = new FakeInstance(valueOf([]));
    const provider = makeProviderOverRowsNeverOnDisk([], { instance });
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e) => fired.push(e));

    instance.fail('EACCES downloads');

    expect(provider.viewMessage()).toBe('Showing the last good read: EACCES downloads');
    expect(fired).toHaveLength(1);
    instance.publish(valueOf([]));
    expect(provider.viewMessage()).toBeUndefined();
  });

  it('renders no rows before the first read, and the read\'s rows once it lands', async () => {
    const instance = new FakeInstance(valueOf([]), SEQUENCE_NOT_READ_YET);
    const provider = makeProviderOverRowsNeverOnDisk([], { instance });

    const pending = provider.getChildren();
    instance.publish(valueOf([row({ name: 'a.zip' })]));

    expect(rowNamesOfDownloadNodes(await pending)).toEqual(['a.zip']);
  });

  it('settles a failed first read, rather than spinning forever, on the one error row naming the reason, then renders rows when a value lands', async () => {
    const instance = new FakeInstance(valueOf([]), SEQUENCE_NOT_READ_YET);
    const provider = makeProviderOverRowsNeverOnDisk([], { instance });

    const pending = provider.getChildren();
    instance.fail('ENOENT: no such file or directory, open modlist.txt');
    const rows = await explicitFailureIfNotSettledWithin(pending, 500);

    expect(rows).toHaveLength(1);
    const error = expectInstanceOf(rows[0], ErrorNode);
    expect(error.label).toBe('Failed to load: ENOENT: no such file or directory, open modlist.txt');
    expect(error.tooltip).toBe('ENOENT: no such file or directory, open modlist.txt');
    expect(error.iconPath).toEqual(new ThemeIcon('error'));

    instance.publish(valueOf([row({ name: 'a.zip' })]));
    const after = await explicitFailureIfNotSettledWithin(provider.getChildren(), 500);

    expect(rowNamesOfDownloadNodes(after)).toEqual(['a.zip']);
  });

  it('renders no rows immediately when the first landed value is genuinely empty', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([], { instance: new FakeInstance(valueOf([]), 1) });
    expect(await provider.getChildren()).toEqual([]);
  });

  it('re-renders when the Instance publishes a new landed value, read again a macrotask after the publish', async () => {
    const instance = new FakeInstance(valueOf([row({ name: 'a.zip' })]));
    const provider = makeProviderOverRowsNeverOnDisk([], { instance });
    expect(rowNamesOfDownloadNodes(await provider.getChildren())).toEqual(['a.zip']);

    instance.publish(valueOf([row({ name: 'a.zip' }), row({ name: 'b.zip' })]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rowNamesOfDownloadNodes(await provider.getChildren()).sort()).toEqual(['a.zip', 'b.zip']);
  });

  it('dispose() disposes the Instance subscription: a publish afterward leaves the cache untouched', async () => {
    const instance = new FakeInstance(valueOf([row({ name: 'a.zip' })]));
    const provider = makeProviderOverRowsNeverOnDisk([], { instance });
    await provider.getChildren();

    provider.dispose();
    instance.publish(valueOf([row({ name: 'a.zip' }), row({ name: 'b.zip' })]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rowNamesOfDownloadNodes(await provider.getChildren())).toEqual(['a.zip']);
  });
});

describe('DownloadsProvider — a configured downloads folder Modbench cannot resolve shows the "Failed to load:" state', () => {
  const REASON = 'download_directory "D:\\Games\\downloads" could not be resolved: '
    + "Cannot translate Wine drive letter 'D:' in 'D:\\Games\\downloads': only Z: and C: are translated";
  const unresolvedValue = () => instanceValueFixture({ downloads: { kind: 'unresolved', reason: REASON } });

  it('renders one error row naming the reason, even though the instance read itself landed', async () => {
    const provider = makeProviderOverRowsNeverOnDisk([], { instance: new FakeInstance(unresolvedValue(), 1) });

    const rows = await provider.getChildren();

    expect(rows).toHaveLength(1);
    const error = expectInstanceOf(rows[0], ErrorNode);
    expect(error.label).toBe(`Failed to load: ${REASON}`);
    expect(error.tooltip).toBe(REASON);
  });

  it('renders only the error row while unresolved, not the a.zip row a stale cache holds', async () => {
    const instance = new FakeInstance(valueOf([row({ name: 'a.zip' })]));
    const provider = makeProviderOverRowsNeverOnDisk([], { instance });
    await provider.getChildren();

    instance.publish(unresolvedValue());
    const rows = await provider.getChildren();

    expect(rows).toHaveLength(1);
    expectInstanceOf(rows[0], ErrorNode);
  });

  it('allExcluded is false while unresolved — there are no rows to be all-excluded', () => {
    const provider = makeProviderOverRowsNeverOnDisk([], { instance: new FakeInstance(unresolvedValue(), 1) });
    expect(provider.allExcluded()).toBe(false);
  });

  it('renders rows again once a later recompute resolves the folder', async () => {
    const instance = new FakeInstance(unresolvedValue(), 1);
    const provider = makeProviderOverRowsNeverOnDisk([], { instance });
    expect(await provider.getChildren()).toHaveLength(1);

    instance.publish(valueOf([row({ name: 'a.zip' })]));

    expect(rowNamesOfDownloadNodes(await provider.getChildren())).toEqual(['a.zip']);
  });
});
