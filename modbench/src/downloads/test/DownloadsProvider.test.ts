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

import { DownloadsProvider, DownloadedFileNode, type DownloadsTreeNode } from '../DownloadsProvider';
import { downloadedFileNodeFixture } from '../../test/mo2/downloadedFileNodeFixture';
import { ErrorNode } from '../../drivingLib/errorNode';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import type { LocatedDownloadedFileRow, DownloadedFileRow, InstanceValue } from '../../instanceLoader/instance';
import { present } from '../../ports/present';

const rowNamesOfDownloadedFileNodes = (nodes: DownloadsTreeNode[]): string[] => nodes.map((n) => expectInstanceOf(n, DownloadedFileNode).argument.row.name);

const row = (extra: Partial<DownloadedFileRow> = {}): LocatedDownloadedFileRow => downloadedFileRowFixture(extra.name ?? 'foo.zip', extra);

function valueOf(downloads: LocatedDownloadedFileRow[]): InstanceValue {
  return instanceValueFixture({ downloadedFiles: { kind: 'listed', rows: downloads } });
}

const SEQUENCE_NOT_READ_YET = 0;

const providerOf = (instance: FakeInstance): DownloadsProvider => new DownloadsProvider({ instance });
const providerOver = (...downloads: LocatedDownloadedFileRow[]): DownloadsProvider => providerOf(new FakeInstance(valueOf(downloads)));

describe('a downloaded file row', () => {
  it('label is the row displayName; id is pinned to the raw filename', () => {
    const node = downloadedFileNodeFixture(row({ name: 'foo_1_2_3.zip', displayName: 'Sleep or Save' }));
    expect(node.label).toBe('Sleep or Save');
    expect(node.id).toBe('foo_1_2_3.zip');
  });

  it('is a flat leaf row (no children)', () => {
    const node = downloadedFileNodeFixture(row());
    expect(node.collapsibleState).toBe(TreeItemCollapsibleState.None);
  });

  it.each<[DownloadedFileRow['status'], ThemeIcon]>([
    ['Downloaded', new ThemeIcon('archive', new ThemeColor('charts.green'))],
    ['Installed', new ThemeIcon('check')],
    ['Uninstalled', new ThemeIcon('circle-slash', new ThemeColor('charts.yellow'))],
  ])('shows the status of a %s file by its icon and colour', (status, icon) => {
    expect(downloadedFileNodeFixture(row({ status })).iconPath).toEqual(icon);
  });

  it.each<[string, DownloadedFileRow['status'], string | undefined, string]>([
    ['a Downloaded file shows only the version, unmarked', 'Downloaded', '2.2.1', 'v2.2.1'],
    ['an Installed file appends the status word after the version', 'Installed', '2.2.1', 'v2.2.1 Installed'],
    ['an Uninstalled file appends the status word after the version', 'Uninstalled', '2.2.1', 'v2.2.1 Uninstalled'],
    ['a Downloaded file with no version shows nothing', 'Downloaded', undefined, ''],
    ['an Installed file with no version shows just the status word', 'Installed', undefined, 'Installed'],
  ])('description: %s', (_case, status, version, description) => {
    expect(downloadedFileNodeFixture(row({ status, version })).description).toBe(description);
  });

  describe('tooltip', () => {
    it('a fully-populated row includes every field', () => {
      const node = downloadedFileNodeFixture(
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
      const node = downloadedFileNodeFixture(row());
      const tooltip = expectInstanceOf(node.tooltip, MarkdownString);
      expect(tooltip.value).toContain('foo.zip');
      expect(tooltip.value).not.toContain('undefined');
    });
  });

  it('offers the menu entries its metadata, its mod id and its excluded state allow', () => {
    const node = downloadedFileNodeFixture(row({ hasMeta: true, modID: '1', excluded: true }));
    expect(node.contextValue).toBe('downloadedFile hasModID hasMeta excluded');
  });

  it('resourceUri is the path the value carries for the row', () => {
    const node = downloadedFileNodeFixture(row({ name: 'foo.zip' }));
    expect(present(node.resourceUri, "the downloaded file node's resourceUri").fsPath).toBe(join('/instance', 'downloads', 'foo.zip'));
  });

  it('exposes the source row for command handlers to act on', () => {
    const r = row();
    expect(downloadedFileNodeFixture(r).argument.row).toBe(r);
  });

  it('carries its metadata file\'s modID as the Nexus mod id view on Nexus opens, and none without one', () => {
    expect(downloadedFileNodeFixture(row({ modID: '123' })).nexusModId).toBe('123');
    expect(downloadedFileNodeFixture(row()).nexusModId).toBeUndefined();
  });

  it('carries its metadata file\'s game as the game view on Nexus opens the page of, and none without one', () => {
    expect(downloadedFileNodeFixture(row({ gameName: 'SkyrimSE' })).gameName).toBe('SkyrimSE');
    expect(downloadedFileNodeFixture(row()).gameName).toBeUndefined();
  });
});

describe('the Downloads rows come from the Instance value', () => {
  it('builds one node per Instance row, default-sorted filetime descending', async () => {
    const provider = providerOver(row({ name: 'old.zip', mtimeMs: 1000 }), row({ name: 'new.zip', mtimeMs: 2000 }));
    expect(rowNamesOfDownloadedFileNodes(await provider.getChildren())).toEqual(['new.zip', 'old.zip']);
  });

  it('narrows to rows whose label contains the filter text, case-insensitively', async () => {
    const provider = providerOver(
      row({ name: 'ArmorPack.zip', displayName: 'ArmorPack.zip' }),
      row({ name: 'WeaponPack.zip', displayName: 'WeaponPack.zip' }),
    );
    await provider.getChildren();
    provider.setFilter('armor');

    expect(rowNamesOfDownloadedFileNodes(await provider.getChildren())).toEqual(['ArmorPack.zip']);
  });

  it('narrows by the label, not the raw filename, which has no "armor" in it', async () => {
    const provider = providerOver(
      row({ name: 'file-one.zip', displayName: 'Armor Pack' }),
      row({ name: 'file-two.zip', displayName: 'Weapon Pack' }),
    );
    await provider.getChildren();
    provider.setFilter('armor');

    expect(rowNamesOfDownloadedFileNodes(await provider.getChildren())).toEqual(['file-one.zip']);
  });

  it('excludes excluded rows by default (Show excluded off)', async () => {
    const provider = providerOver(row({ name: 'excluded.zip', excluded: true }), row({ name: 'visible.zip' }));
    expect(rowNamesOfDownloadedFileNodes(await provider.getChildren())).toEqual(['visible.zip']);
  });

  it('returns no children when the Instance value has no downloads', async () => {
    const provider = providerOver();
    expect(await provider.getChildren()).toEqual([]);
  });

  it('a non-root element (a downloaded file row) has no children of its own', async () => {
    const provider = providerOver(row({ name: 'foo.zip' }));
    const [node] = await provider.getChildren();
    expect(await provider.getChildren(node)).toEqual([]);
  });
});

describe('Show excluded', () => {
  it('includes excluded rows alongside visible ones when turned on', async () => {
    const provider = providerOver(row({ name: 'excluded.zip', excluded: true }), row({ name: 'visible.zip' }));
    provider.setShowExcluded(true);
    const nodes = await provider.getChildren();
    expect(rowNamesOfDownloadedFileNodes(nodes).sort()).toEqual(['excluded.zip', 'visible.zip']);
    expect(nodes.map((n) => expectInstanceOf(n, DownloadedFileNode).argument.row).find((r) => r.name === 'excluded.zip')?.excluded).toBe(true);
  });

  it('excludes excluded rows again once turned back off', async () => {
    const provider = providerOver(row({ name: 'excluded.zip', excluded: true }), row({ name: 'visible.zip' }));
    provider.setShowExcluded(true);
    await provider.getChildren();
    provider.setShowExcluded(false);
    expect(rowNamesOfDownloadedFileNodes(await provider.getChildren())).toEqual(['visible.zip']);
  });

  it('re-renders: fires onDidChangeTreeData', async () => {
    const provider = providerOver();
    await provider.getChildren();
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.setShowExcluded(true);
    expect(fired).toBe(true);
  });
});

describe('the sort', () => {
  it('re-sorts by name ascending, overriding the default Filetime-descending order', async () => {
    const provider = providerOver(row({ name: 'banana.zip', displayName: 'banana.zip' }), row({ name: 'apple.zip', displayName: 'apple.zip' }));
    provider.setSort('name', false);
    expect(rowNamesOfDownloadedFileNodes(await provider.getChildren())).toEqual(['apple.zip', 'banana.zip']);
  });

  it('re-renders: fires onDidChangeTreeData', async () => {
    const provider = providerOver();
    await provider.getChildren();
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.setSort('name', false);
    expect(fired).toBe(true);
  });

  it('starts at the spec default: Filetime, descending', () => {
    expect(providerOver().currentSort()).toEqual({ column: 'mtimeMs', descending: true });
  });

  it('is the sort last applied', () => {
    const provider = providerOver();
    provider.setSort('name', false);
    expect(provider.currentSort()).toEqual({ column: 'name', descending: false });
  });
});

describe('allExcluded, distinct from no downloads: files exist but every one is hidden by Show excluded being off', () => {
  it('is false with no downloads at all', () => {
    expect(providerOver().allExcluded()).toBe(false);
  });

  it('is false when at least one row is not excluded', () => {
    const provider = providerOver(row({ name: 'excluded.zip', excluded: true }), row({ name: 'visible.zip' }));
    expect(provider.allExcluded()).toBe(false);
  });

  it('is true when every row is excluded and Show excluded is off', () => {
    const provider = providerOver(row({ name: 'a.zip', excluded: true }), row({ name: 'b.zip', excluded: true }));
    expect(provider.allExcluded()).toBe(true);
  });

  it('is false once Show excluded is turned on, even with every row excluded', () => {
    const provider = providerOver(row({ name: 'a.zip', excluded: true }), row({ name: 'b.zip', excluded: true }));
    provider.setShowExcluded(true);
    expect(provider.allExcluded()).toBe(false);
  });
});

describe('the names of the excluded rows the view shows', () => {
  it('is empty before any render', () => {
    expect(providerOver().excludedNames()).toEqual(new Set());
  });

  it('is empty while Show excluded is off, even with excluded rows in the value', async () => {
    const provider = providerOver(row({ name: 'excluded.zip', excluded: true }));
    await provider.getChildren();
    expect(provider.excludedNames()).toEqual(new Set());
  });

  it('lists excluded row names once Show excluded is on and the tree has rendered', async () => {
    const provider = providerOver(row({ name: 'excluded.zip', excluded: true }), row({ name: 'visible.zip' }));
    provider.setShowExcluded(true);
    await provider.getChildren();
    expect(provider.excludedNames()).toEqual(new Set(['excluded.zip']));
  });
});

describe('the Downloads view reacts to the Instance, never scans on its own', () => {
  it('says it shows the last good read, with the reason, when a later read fails, and not once a read lands', () => {
    const instance = new FakeInstance(valueOf([]));
    const provider = providerOf(instance);
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
    const provider = providerOf(instance);

    const pending = provider.getChildren();
    instance.publish(valueOf([row({ name: 'a.zip' })]));

    expect(rowNamesOfDownloadedFileNodes(await pending)).toEqual(['a.zip']);
  });

  it('settles a failed first read, rather than spinning forever, on the one error row naming the reason, then renders rows when a value lands', async () => {
    const instance = new FakeInstance(valueOf([]), SEQUENCE_NOT_READ_YET);
    const provider = providerOf(instance);

    const pending = provider.getChildren();
    instance.fail('ENOENT: no such file or directory, open modlist.txt');

    expect(await pending).toEqual([new ErrorNode('ENOENT: no such file or directory, open modlist.txt')]);

    instance.publish(valueOf([row({ name: 'a.zip' })]));

    expect(rowNamesOfDownloadedFileNodes(await provider.getChildren())).toEqual(['a.zip']);
  });

  it('renders no rows immediately when the first landed value is genuinely empty', async () => {
    const provider = providerOf(new FakeInstance(valueOf([]), 1));
    expect(await provider.getChildren()).toEqual([]);
  });

  it('re-renders when the Instance publishes a new landed value', async () => {
    const instance = new FakeInstance(valueOf([row({ name: 'a.zip' })]));
    const provider = providerOf(instance);
    expect(rowNamesOfDownloadedFileNodes(await provider.getChildren())).toEqual(['a.zip']);

    instance.publish(valueOf([row({ name: 'a.zip' }), row({ name: 'b.zip' })]));

    expect(rowNamesOfDownloadedFileNodes(await provider.getChildren()).sort()).toEqual(['a.zip', 'b.zip']);
  });

  it('dispose() disposes the Instance subscription: a publish afterward leaves the cache untouched', async () => {
    const instance = new FakeInstance(valueOf([row({ name: 'a.zip' })]));
    const provider = providerOf(instance);
    await provider.getChildren();

    provider.dispose();
    instance.publish(valueOf([row({ name: 'a.zip' }), row({ name: 'b.zip' })]));

    expect(rowNamesOfDownloadedFileNodes(await provider.getChildren())).toEqual(['a.zip']);
  });
});

describe('a configured downloads folder Modbench cannot resolve shows the "Failed to load:" state', () => {
  const REASON = 'download_directory "D:\\Games\\downloads" could not be resolved: '
    + "Cannot translate Wine drive letter 'D:' in 'D:\\Games\\downloads': only Z: and C: are translated";
  const unresolvedValue = () => instanceValueFixture({ downloadedFiles: { kind: 'unresolved', reason: REASON } });

  it('renders one error row naming the reason, even though the instance read itself landed', async () => {
    const provider = providerOf(new FakeInstance(unresolvedValue(), 1));

    expect(await provider.getChildren()).toEqual([new ErrorNode(REASON)]);
  });

  it('renders only the error row while unresolved, not the a.zip row a stale cache holds', async () => {
    const instance = new FakeInstance(valueOf([row({ name: 'a.zip' })]));
    const provider = providerOf(instance);
    await provider.getChildren();

    instance.publish(unresolvedValue());

    expect(await provider.getChildren()).toEqual([new ErrorNode(REASON)]);
  });

  it('allExcluded is false while unresolved — there are no rows to be all-excluded', () => {
    const provider = providerOf(new FakeInstance(unresolvedValue(), 1));
    expect(provider.allExcluded()).toBe(false);
  });

  it('renders rows again once a later recompute resolves the folder', async () => {
    const instance = new FakeInstance(unresolvedValue(), 1);
    const provider = providerOf(instance);
    await provider.getChildren();

    instance.publish(valueOf([row({ name: 'a.zip' })]));

    expect(rowNamesOfDownloadedFileNodes(await provider.getChildren())).toEqual(['a.zip']);
  });
});
