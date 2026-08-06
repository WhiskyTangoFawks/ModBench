import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn() }));

vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    id?: string;
    description?: string;
    tooltip?: unknown;
    contextValue?: string;
    iconPath?: unknown;
    resourceUri?: unknown;
    collapsibleState: number;
    constructor(label: string, collapsibleState = 0) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    private readonly handlers: ((e: unknown) => void)[] = [];
    get event() { return (h: (e: unknown) => void) => { this.handlers.push(h); }; }
    fire(e?: unknown) { this.handlers.forEach(h => h(e)); }
  },
  ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
  ThemeColor: class { constructor(public id: string) {} },
  MarkdownString: class { value: string; constructor(v = '') { this.value = v; } },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
  commands: { executeCommand },
}));

import { DownloadsProvider, DownloadNode } from './DownloadsProvider';
import type { DownloadRow } from './mo2/downloads';

const row = (extra: Partial<DownloadRow> = {}): DownloadRow => ({
  name: 'foo.zip',
  displayName: 'foo.zip',
  status: 'Downloaded',
  size: 100,
  mtimeMs: 1700000000000,
  hasMeta: false,
  hidden: false,
  ...extra,
});

// ── DownloadNode field construction (slices 4-9) ────────────────────────────

describe('DownloadNode', () => {
  it('label is the row displayName; id is pinned to the raw filename', () => {
    const node = new DownloadNode(row({ name: 'foo_1_2_3.zip', displayName: 'Sleep or Save' }), '/instance');
    expect(node.label).toBe('Sleep or Save');
    expect(node.id).toBe('foo_1_2_3.zip');
  });

  it('is a flat leaf row (no children)', () => {
    const node = new DownloadNode(row(), '/instance');
    expect(node.collapsibleState).toBe(0); // TreeItemCollapsibleState.None
  });

  describe('status icon + colour', () => {
    it('Downloaded -> archive icon, green', () => {
      const node = new DownloadNode(row({ status: 'Downloaded' }), '/instance');
      const icon = node.iconPath as { id: string; color?: { id: string } };
      expect(icon.id).toBe('archive');
      expect(icon.color?.id).toBe('charts.green');
    });

    it('Installed -> check icon, no explicit colour', () => {
      const node = new DownloadNode(row({ status: 'Installed' }), '/instance');
      const icon = node.iconPath as { id: string; color?: unknown };
      expect(icon.id).toBe('check');
      expect(icon.color).toBeUndefined();
    });

    it('Uninstalled -> circle-slash icon, yellow', () => {
      const node = new DownloadNode(row({ status: 'Uninstalled' }), '/instance');
      const icon = node.iconPath as { id: string; color?: { id: string } };
      expect(icon.id).toBe('circle-slash');
      expect(icon.color?.id).toBe('charts.yellow');
    });
  });

  describe('description', () => {
    it('Downloaded (default) shows only the version, unmarked', () => {
      const node = new DownloadNode(row({ status: 'Downloaded', version: '2.2.1' }), '/instance');
      expect(node.description).toBe('v2.2.1');
    });

    it('Installed appends the status word after the version', () => {
      const node = new DownloadNode(row({ status: 'Installed', version: '2.2.1' }), '/instance');
      expect(node.description).toBe('v2.2.1 Installed');
    });

    it('Uninstalled appends the status word after the version', () => {
      const node = new DownloadNode(row({ status: 'Uninstalled', version: '2.2.1' }), '/instance');
      expect(node.description).toBe('v2.2.1 Uninstalled');
    });

    it('omits the version entirely when absent, leaving just the status word (or nothing)', () => {
      expect(new DownloadNode(row({ status: 'Downloaded' }), '/instance').description).toBe('');
      expect(new DownloadNode(row({ status: 'Installed' }), '/instance').description).toBe('Installed');
    });
  });

  describe('tooltip', () => {
    it('a fully-populated row includes every field', () => {
      const node = new DownloadNode(
        row({
          modName: 'Sleep or Save', version: '2.2.1', modID: '12345', size: 4096,
          mtimeMs: Date.parse('2024-01-15T10:00:00Z'), gameName: 'Fallout4', author: 'SomeAuthor',
        }),
        '/instance',
      );
      const tooltip = node.tooltip as { value: string };
      expect(tooltip.value).toContain('foo.zip');
      expect(tooltip.value).toContain('Sleep or Save');
      expect(tooltip.value).toContain('2.2.1');
      expect(tooltip.value).toContain('12345');
      expect(tooltip.value).toContain('4096');
      expect(tooltip.value).toContain('Fallout4');
      expect(tooltip.value).toContain('SomeAuthor');
    });

    it('a minimal row (filename only) omits every optional field without erroring', () => {
      const node = new DownloadNode(row(), '/instance');
      const tooltip = node.tooltip as { value: string };
      expect(tooltip.value).toContain('foo.zip');
      expect(tooltip.value).not.toContain('undefined');
    });
  });

  it('contextValue is the row\'s downloadContextValue', () => {
    const node = new DownloadNode(row({ hasMeta: true, modID: '1', hidden: true }), '/instance');
    expect(node.contextValue).toBe('download hasMeta hasModID hidden');
  });

  it('resourceUri points at the archive under <instanceRoot>/downloads/<name>', () => {
    const node = new DownloadNode(row({ name: 'foo.zip' }), '/instance');
    expect((node.resourceUri as { fsPath: string }).fsPath).toBe(join('/instance', 'downloads', 'foo.zip'));
  });

  it('exposes the source row for command handlers to act on', () => {
    const r = row();
    expect(new DownloadNode(r, '/instance').row).toBe(r);
  });
});

// ── DownloadsProvider.getChildren (slices 10-13) ────────────────────────────

describe('DownloadsProvider', () => {
  let instanceRoots: string[] = [];

  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    await Promise.all(instanceRoots.map((root) => rm(root, { recursive: true, force: true })));
    instanceRoots = [];
  });

  async function makeInstanceRoot(withDownloadsDir = true): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'downloads-provider-'));
    if (withDownloadsDir) await mkdir(join(root, 'downloads'), { recursive: true });
    instanceRoots.push(root);
    return root;
  }

  async function writeArchive(root: string, name: string, meta?: string): Promise<void> {
    await writeFile(join(root, 'downloads', name), 'data');
    if (meta !== undefined) await writeFile(join(root, 'downloads', `${name}.meta`), meta);
  }

  it('builds one node per archive, default-sorted filetime descending', async () => {
    const root = await makeInstanceRoot();
    await writeFile(join(root, 'downloads', 'old.zip'), 'x');
    await utimes(join(root, 'downloads', 'old.zip'), new Date(1000), new Date(1000));
    await writeFile(join(root, 'downloads', 'new.zip'), 'x');
    await utimes(join(root, 'downloads', 'new.zip'), new Date(2000), new Date(2000));

    const provider = new DownloadsProvider(root);
    const children = await provider.getChildren();
    expect(children.map((n) => n.row.name)).toEqual(['new.zip', 'old.zip']);
  });

  it('excludes hidden rows (no show-hidden toggle in this slice)', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'hidden.zip', '[General]\r\nremoved=true\r\n');
    await writeArchive(root, 'visible.zip');

    const provider = new DownloadsProvider(root);
    const children = await provider.getChildren();
    expect(children.map((n) => n.row.name)).toEqual(['visible.zip']);
  });

  it('returns no children (not an error) for an empty downloads/ folder', async () => {
    const root = await makeInstanceRoot();
    const provider = new DownloadsProvider(root);
    expect(await provider.getChildren()).toEqual([]);
  });

  it('returns no children when downloads/ does not exist at all', async () => {
    const root = await makeInstanceRoot(false);
    const provider = new DownloadsProvider(root);
    expect(await provider.getChildren()).toEqual([]);
  });

  it('a non-root element (a download row) has no children of its own', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.zip');
    const provider = new DownloadsProvider(root);
    const [node] = await provider.getChildren();
    expect(await provider.getChildren(node)).toEqual([]);
  });

  describe('modbench.downloadsFolderExists context key', () => {
    it('sets false when downloads/ does not exist', async () => {
      const root = await makeInstanceRoot(false);
      await new DownloadsProvider(root).getChildren();
      expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.downloadsFolderExists', false);
    });

    it('sets true when downloads/ exists (empty or populated)', async () => {
      const root = await makeInstanceRoot();
      await new DownloadsProvider(root).getChildren();
      expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.downloadsFolderExists', true);
    });
  });

  describe('invalidate', () => {
    it('clears the cache and fires onDidChangeTreeData, so the next getChildren re-scans', async () => {
      const root = await makeInstanceRoot();
      const provider = new DownloadsProvider(root);
      expect(await provider.getChildren()).toEqual([]);

      await writeArchive(root, 'new.zip');
      let fired = false;
      provider.onDidChangeTreeData(() => { fired = true; });
      provider.invalidate();
      expect(fired).toBe(true);

      const children = await provider.getChildren();
      expect(children.map((n) => n.row.name)).toEqual(['new.zip']);
    });
  });
});
