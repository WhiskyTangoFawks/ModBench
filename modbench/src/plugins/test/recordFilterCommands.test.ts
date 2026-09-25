import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  handlers, registerCommand, executeCommand, showQuickPick, showTextDocument, openTextDocument, files,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn(),
    showQuickPick: vi.fn<(items: { label: string }[]) => Promise<{ label: string } | undefined>>(),
    showTextDocument: vi.fn(),
    openTextDocument: vi.fn(),
    files: new Map<string, string>(),
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand, executeCommand },
  window: { showQuickPick, showTextDocument },
  workspace: { openTextDocument },
}));

import { makeShowRecordFilter, registerFilterCommands, type FilterCommandDeps } from '../recordFilterCommands';
import { InMemoryMEditClient } from '../../client';
import { recordingReporter, type RecordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { posix } from 'node:path';

const ARMOR_SQL = 'SELECT form_key FROM "armo"';

beforeEach(() => {
  handlers.clear();
  files.clear();
  vi.clearAllMocks();
});

function registered(
  client: InMemoryMEditClient, nameOf: (uri: { path: string }) => string = (uri) => posix.basename(uri.path),
): FilterCommandDeps & {
  treeProvider: { refresh: ReturnType<typeof vi.fn> };
  refreshMatchingPlugins: ReturnType<typeof vi.fn>;
  showRecordFilter: ReturnType<typeof vi.fn>;
  reporter: RecordingReporter;
} {
  const deps = {
    scripts: {
      folder: '/scripts',
      sqlFiles: () => [...files.keys()].filter((name) => name.endsWith('.sql')),
      read: (name: string) => present(files.get(name), `the script ${name}`),
      nameOf,
    },
    client,
    treeProvider: { refresh: vi.fn() },
    refreshMatchingPlugins: vi.fn(),
    showRecordFilter: vi.fn(),
    reporter: recordingReporter(),
  };
  registerFilterCommands(deps);
  return deps;
}

const filter = (...args: unknown[]) => present(handlers.get('modbench.record.filter'), 'the modbench.record.filter handler')(...args);
const clearFilter = () => present(handlers.get('modbench.record.clearFilter'), 'the modbench.record.clearFilter handler')();

function pickedLabels(): string[] {
  const [items] = present(showQuickPick.mock.calls[0], 'the pick shown');
  return items.map((i) => i.label);
}

describe('modbench.record.filter, from the input box', () => {
  it('lists the scripts folder\'s .sql files, then New filter… last', async () => {
    files.set('armor.sql', ARMOR_SQL).set('notes.py', '').set('weapons.sql', '');
    registered(new InMemoryMEditClient());

    await filter();

    expect(pickedLabels()).toEqual(['armor.sql', 'weapons.sql', '$(add) New filter…']);
  });

  it('applies nothing on Esc', async () => {
    files.set('armor.sql', ARMOR_SQL);
    const client = new InMemoryMEditClient();
    const deps = registered(client);
    showQuickPick.mockResolvedValue(undefined);

    await filter();

    expect(client.calls.filter((c) => c.method === 'setFilter')).toEqual([]);
    expect(deps.showRecordFilter).not.toHaveBeenCalled();
    expect(deps.treeProvider.refresh).not.toHaveBeenCalled();
  });

  it('applies a picked file\'s SQL, named by the file', async () => {
    files.set('armor.sql', ARMOR_SQL);
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('setFilter', null);
    const deps = registered(client);
    showQuickPick.mockImplementation((items: { label: string }[]) => Promise.resolve(items[0]));

    await filter();

    expect(client.calls).toContainEqual({ method: 'setFilter', args: [{ sql: ARMOR_SQL, source: 'armor.sql' }] });
    expect(deps.showRecordFilter).toHaveBeenCalledWith({ sql: ARMOR_SQL, source: 'armor.sql' });
    expect(deps.treeProvider.refresh).toHaveBeenCalledOnce();
    expect(deps.refreshMatchingPlugins).toHaveBeenCalledOnce();
  });

  it('opens an untitled SQL document for New filter…, and applies nothing', async () => {
    const client = new InMemoryMEditClient();
    const deps = registered(client);
    const untitled = { uri: 'untitled:Untitled-1' };
    openTextDocument.mockResolvedValue(untitled);
    showQuickPick.mockImplementation((items: { label: string }[]) => Promise.resolve(items.at(-1)));

    await filter();

    expect(openTextDocument).toHaveBeenCalledWith({ language: 'sql' });
    expect(showTextDocument).toHaveBeenCalledWith(untitled);
    expect(client.calls.filter((c) => c.method === 'setFilter')).toEqual([]);
    expect(deps.showRecordFilter).not.toHaveBeenCalled();
  });
});

describe('modbench.record.filter, from a document', () => {
  it('applies the document\'s text, named by the document, without asking', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('setFilter', null);
    const deps = registered(client);
    const uri = { scheme: 'untitled', path: 'Untitled-1' };
    openTextDocument.mockResolvedValue({ uri, fileName: 'Untitled-1', getText: () => ARMOR_SQL });

    await filter(uri);

    expect(openTextDocument).toHaveBeenCalledWith(uri);
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(client.calls).toContainEqual({ method: 'setFilter', args: [{ sql: ARMOR_SQL, source: 'Untitled-1' }] });
    expect(deps.showRecordFilter).toHaveBeenCalledWith({ sql: ARMOR_SQL, source: 'Untitled-1' });
  });

  it('names a document by the name the composition root gives it', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('setFilter', null);
    const deps = registered(client, () => 'from-the-root.sql');
    const uri = { scheme: 'file', path: '/elsewhere/queries/armor.sql' };
    openTextDocument.mockResolvedValue({ uri, fileName: '/elsewhere/queries/armor.sql', getText: () => ARMOR_SQL });

    await filter(uri);

    expect(deps.showRecordFilter).toHaveBeenCalledWith({ sql: ARMOR_SQL, source: 'from-the-root.sql' });
  });

  // The rival: showing the filter (or refreshing) on a failed set would leave the view claiming a
  // filter mEdit never took.
  it('reports a refused set and touches nothing else', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('setFilter', 'Filter SQL must return a form_key column');
    const deps = registered(client);
    openTextDocument.mockResolvedValue({ uri: { scheme: 'untitled', path: 'Untitled-1' }, fileName: 'Untitled-1', getText: () => 'SELECT editor_id FROM "npc_"' });

    await filter({ scheme: 'untitled', path: 'Untitled-1' });

    expect(deps.reporter.reports).toEqual([
      { severity: 'error', message: 'Filter failed — Filter SQL must return a form_key column', detail: undefined },
    ]);
    expect(deps.showRecordFilter).not.toHaveBeenCalled();
    expect(deps.treeProvider.refresh).not.toHaveBeenCalled();
    expect(deps.refreshMatchingPlugins).not.toHaveBeenCalled();
  });
});

describe('modbench.record.clearFilter', () => {
  // A clear refreshes exactly as a set does, or a stale no-match row survives the filter that
  // hid it.
  it('shows no filter and refreshes the tree and the matching plugins, as a set does', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('clearFilter', null);
    const deps = registered(client);

    await clearFilter();

    expect(client.calls).toContainEqual({ method: 'clearFilter', args: [] });
    expect(deps.showRecordFilter).toHaveBeenCalledWith(null);
    expect(deps.treeProvider.refresh).toHaveBeenCalledOnce();
    expect(deps.refreshMatchingPlugins).toHaveBeenCalledOnce();
  });

  // plugins.md, Order and view state, story 5: mEdit still filters, so the view keeps saying so.
  it('reports a refused clear and keeps showing the filter', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('clearFilter', 'No load order has been received yet.');
    const deps = registered(client);

    await clearFilter();

    expect(deps.reporter.reports).toEqual([
      { severity: 'error', message: 'Could not clear the record filter — No load order has been received yet.', detail: undefined },
    ]);
    expect(deps.showRecordFilter).not.toHaveBeenCalled();
    expect(deps.treeProvider.refresh).not.toHaveBeenCalled();
    expect(deps.refreshMatchingPlugins).not.toHaveBeenCalled();
  });
});

// The one writer of everything that says a record filter is in force.
describe('makeShowRecordFilter', () => {
  function shown() {
    const lens = { setActiveSql: vi.fn() };
    const views = {
      pluginsNameFilter: { setBaseDescription: vi.fn() },
      pluginsTree: { setRecordFilterSource: vi.fn() },
    };
    return { lens, views, show: makeShowRecordFilter(lens, views) };
  }

  it('names the source in the view\'s description and hands it to the message, never the SQL', () => {
    const { lens, views, show } = shown();

    show({ sql: ARMOR_SQL, source: 'armor.sql' });

    expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.record.filterActive', true);
    expect(lens.setActiveSql).toHaveBeenCalledWith(ARMOR_SQL);
    expect(views.pluginsNameFilter.setBaseDescription).toHaveBeenCalledWith('records: armor.sql');
    expect(views.pluginsTree.setRecordFilterSource).toHaveBeenCalledWith('armor.sql');
  });

  it('says nothing of a filter once none is in force', () => {
    const { lens, views, show } = shown();

    show(null);

    expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.record.filterActive', false);
    expect(lens.setActiveSql).toHaveBeenCalledWith(null);
    expect(views.pluginsNameFilter.setBaseDescription).toHaveBeenCalledWith(undefined);
    expect(views.pluginsTree.setRecordFilterSource).toHaveBeenCalledWith(undefined);
  });
});
