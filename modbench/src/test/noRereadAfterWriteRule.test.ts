import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import { noRereadAfterWrite, WRITES, VIEW_REREADS } from '../../eslint-rules/noRereadAfterWrite.mjs';

const MESSAGE =
  'A write writes its file and returns. A view changes only when the watch reads the file back: the '
  + "Instance loader's next value for the instance's files, mEdit's published rows for plugin source. "
  + 'A write path never refreshes or invalidates a view, landed or failed (ADR-0015 invariant 2).';

function lint(code: string): Linter.LintMessage[] {
  const linter = new Linter();
  return linter.verify(code, {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    plugins: { local: { rules: { x: noRereadAfterWrite } } },
    rules: { 'local/x': 'error' },
  });
}

describe('no-reread-after-write', () => {
  it('fails a planted invalidate after a plugins.txt write, with the rule\'s own message', () => {
    const messages = lint('async function f(tree) { await setPluginsParticipation(root, entries); tree.invalidate(); }\n');

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toBe(MESSAGE);
  });

  it.each([...WRITES])('fails a refresh beside the %s write', (write) => {
    const messages = lint(`async function f(client, tree) { await client.${write}(x); tree.refresh(); }\n`);

    expect(messages).toHaveLength(1);
  });

  it.each([...VIEW_REREADS])('fails %s beside a write', (reread) => {
    const messages = lint(`async function f(client, tree) { await client.createRecord(x); tree.${reread}(); }\n`);

    expect(messages).toHaveLength(1);
  });

  it('fails a tree-data event fired straight after a drop\'s write', () => {
    const messages = lint('async function handleDrop(names, drop) { await this.source.reorderPlugins(names, drop); this._onDidChangeTreeData.fire(undefined); }\n');

    expect(messages).toHaveLength(1);
  });

  it('fails a re-read the write path was handed as a bare function', () => {
    const messages = lint('async function f(invalidate) { const r = await setPluginsParticipation(x); if (!r.applied) invalidate(); }\n');

    expect(messages).toHaveLength(1);
  });

  it('fails each re-read of a closure the command it registers calls after its write', () => {
    const messages = lint([
      'function register(client, treeSync, refreshMatchingPlugins) {',
      '  const onWritten = () => { treeSync.refresh(); refreshMatchingPlugins(); };',
      '  return registerCommand(async () => { await client.createRecord(x); onWritten(); });',
      '}',
    ].join('\n'));

    expect(messages).toHaveLength(2);
  });

  it('fails the call of a module-level helper that re-reads, made after a write', () => {
    const messages = lint([
      'function refreshAfterWrite(deps) { deps.refreshTree(); deps.refreshMatchingPlugins(); }',
      'async function dispatchKeep(deps, origin) { await deps.client.keepAsMyEdit(origin); refreshAfterWrite(deps); }',
    ].join('\n'));

    expect(messages).toHaveLength(1);
    expect(messages[0]?.line).toBe(2);
  });

  it('fails the call of a module-level arrow helper that re-reads, made after a write', () => {
    const messages = lint([
      'const rereadAll = (tree) => tree.invalidate();',
      'async function f(tree) { await appendPlugin(root, profile, name); rereadAll(tree); }',
    ].join('\n'));

    expect(messages).toHaveLength(1);
  });

  it('fails a re-read beside the call of a module-level helper that writes', () => {
    const messages = lint([
      'async function appendCreated(root, name) { await appendPlugin(root, "Default", name); }',
      'async function create(tree) { await appendCreated(root, name); tree.invalidate(); }',
    ].join('\n'));

    expect(messages).toHaveLength(1);
  });

  it('passes a function that calls a helper which only registers a writing callback, and re-reads', () => {
    const messages = lint([
      'function registerView(view, root) { view.onDidChangeCheckboxState((e) => onPluginCheckboxChanged(e, root)); }',
      'function build(view, instance) { registerView(view, root); instance.refresh(); }',
    ].join('\n'));

    expect(messages).toEqual([]);
  });

  it('passes a helper that neither writes nor re-reads', () => {
    const messages = lint([
      'function say(reporter) { reporter.landed("Kept."); }',
      'async function f(client, reporter) { await client.keepAsMyEdit(x); say(reporter); }',
    ].join('\n'));

    expect(messages).toEqual([]);
  });

  it('reports a re-read once however many functions around it also write', () => {
    const messages = lint('async function outer(c, t) { await c.track(x); async function inner() { await c.track(y); t.refresh(); } }\n');

    expect(messages).toHaveLength(1);
  });

  it('passes a re-read with no write beside it: setting the record filter is view state, not a write', () => {
    const messages = lint('async function setFilter(client, tree, refreshMatchingPlugins) { await client.setFilter(sql); tree.refresh(); refreshMatchingPlugins(); }\n');

    expect(messages).toEqual([]);
  });

  it('passes a write and a re-read in sibling functions: the drop writes, the instance subscription re-reads', () => {
    const messages = lint([
      'class Provider {',
      '  constructor(instance) { instance.subscribe(() => this.invalidate()); }',
      '  async handleDrop(names, drop) { await this.source.reorderPlugins(names, drop); }',
      '}',
    ].join('\n'));

    expect(messages).toEqual([]);
  });

  it('passes a write that re-reads nothing', () => {
    const messages = lint('async function f(client, reporter) { await client.copyRecords(x); reporter.landed("Copied."); }\n');

    expect(messages).toEqual([]);
  });
});
