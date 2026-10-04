import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import { noRereadAfterWrite, WRITES, VIEW_REREADS } from '../../eslint-rules/noRereadAfterWrite.mjs';

const MESSAGE =
  "A write writes its file and returns. A view changes only when a read lands: the Instance loader's, which "
  + "runWritingGesture asks for once the command ends, or mEdit's published rows for plugin source. "
  + 'A write path never refreshes or invalidates a view itself, landed or failed (ADR-0015).';

function lint(code: string): Linter.LintMessage[] {
  const linter = new Linter();
  return linter.verify(code, {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    plugins: { local: { rules: { x: noRereadAfterWrite } } },
    rules: { 'local/x': 'error' },
  });
}

const lines = (...source: string[]) => lint(source.join('\n'));

describe('no-reread-after-write judges a function by what a call of it runs', () => {
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

  it('passes a write run through runWritingGesture, and fails an instance refresh beside the write inside it', () => {
    const through = lint('async function f(client, instance) { await client.track(x); await runWritingGesture(view, instance, noop); }\n');
    const beside = lint('function f(client, instance) { return runWritingGesture(view, instance, async () => { await client.track(x); instance.refresh(); }); }\n');

    expect(through).toEqual([]);
    expect(beside).toHaveLength(1);
  });

  it('fails a tree-data event fired straight after a drop\'s write', () => {
    const messages = lint('async function handleDrop(names, drop) { await this.source.reorderPlugins(names, drop); this._onDidChangeTreeData.fire(undefined); }\n');

    expect(messages).toHaveLength(1);
  });

  it('fails a re-read the write path was handed as a bare function', () => {
    const messages = lint('async function f(invalidate) { const r = await setPluginsParticipation(x); if (!r.applied) invalidate(); }\n');

    expect(messages).toHaveLength(1);
  });

  it('fails the call of a closure that re-reads, made by the command callback that writes', () => {
    const messages = lines(
      'function register(client, treeSync, refreshMatchingPlugins) {',
      '  const onWritten = () => { treeSync.refresh(); refreshMatchingPlugins(); };',
      '  return registerCommand(async () => { await client.createRecord(x); onWritten(); });',
      '}',
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.line).toBe(3);
  });

  it('fails the call of a module-level helper that re-reads, made after a write', () => {
    const messages = lines(
      'function refreshAfterWrite(deps) { deps.refreshTree(); deps.refreshMatchingPlugins(); }',
      'async function dispatchTrack(deps, plugins) { await deps.client.track(plugins); refreshAfterWrite(deps); }',
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.line).toBe(2);
  });

  it('fails the call of a helper declared after the function that calls it', () => {
    const messages = lines(
      'async function dispatchTrack(deps, plugins) { await deps.client.track(plugins); refreshAfterWrite(deps); }',
      'function refreshAfterWrite(deps) { deps.refreshTree(); }',
    );

    expect(messages).toHaveLength(1);
  });

  it('fails the call of an arrow helper that re-reads, made after a write', () => {
    const messages = lines(
      'const rereadAll = (tree) => tree.invalidate();',
      'async function f(tree) { await appendPlugin(root, profile, name); rereadAll(tree); }',
    );

    expect(messages).toHaveLength(1);
  });

  it('fails the call of a function-expression helper that re-reads, made after a write', () => {
    const messages = lines(
      'const rereadAll = function (tree) { tree.invalidate(); };',
      'async function f(tree) { await appendPlugin(root, profile, name); rereadAll(tree); }',
    );

    expect(messages).toHaveLength(1);
  });

  it('fails the call of an export default function helper that re-reads, made after a write', () => {
    const messages = lines(
      'export default function rereadAll(tree) { tree.invalidate(); }',
      'async function f(tree) { await appendPlugin(root, profile, name); rereadAll(tree); }',
    );

    expect(messages).toHaveLength(1);
  });

  it('passes an anonymous export default function, which no name can call', () => {
    const messages = lines(
      'export default function (tree) { tree.invalidate(); }',
      'async function f(client) { await client.track(x); }',
    );

    expect(messages).toEqual([]);
  });

  it('fails a re-read beside the call of a helper that writes', () => {
    const messages = lines(
      'async function appendCreated(root, name) { await appendPlugin(root, "Default", name); }',
      'async function create(tree) { await appendCreated(root, name); tree.invalidate(); }',
    );

    expect(messages).toHaveLength(1);
  });

  it('fails a re-read chained on a write with .then, as part of the caller', () => {
    const messages = lint('async function f(client, tree) { await client.createRecord(x).then(() => tree.refresh()); }\n');

    expect(messages).toHaveLength(1);
  });

  it('fails a re-read chained on a write with .finally, past a .then, as part of the caller', () => {
    const messages = lint('function f(client, tree) { return client.copyRecords(x).then(report).finally(() => tree.invalidate()); }\n');

    expect(messages).toHaveLength(1);
  });

  it('fails a re-read in an inline function passed to a write, as part of the caller', () => {
    const messages = lint('async function f(tree) { await setPluginsParticipation(x, () => tree.refresh()); }\n');

    expect(messages).toHaveLength(1);
  });

  it('fails a re-read chained on a same-file helper that writes', () => {
    const messages = lines(
      'async function appendCreated(root, name) { await appendPlugin(root, "Default", name); }',
      'function create(tree) { return appendCreated(root, name).then(() => tree.invalidate()); }',
    );

    expect(messages).toHaveLength(1);
  });

  it('passes a re-read in an inline function passed to a call that is not a write', () => {
    const messages = lint('function build(view, tree) { view.onDidChangeSelection(() => tree.refresh()); onPluginCheckboxChanged(e, root); }\n');

    expect(messages).toEqual([]);
  });

  it('passes a re-read in a function that only defines a callback which writes, written inline', () => {
    const messages = lint('function build(view, instance) { view.onDidChangeCheckboxState((e) => onPluginCheckboxChanged(e, root)); instance.refresh(); }\n');

    expect(messages).toEqual([]);
  });

  it('passes a re-read in a function that calls a helper which only defines a callback that writes', () => {
    const messages = lines(
      'function registerView(view, root) { view.onDidChangeCheckboxState((e) => onPluginCheckboxChanged(e, root)); }',
      'function build(view, instance) { registerView(view, root); instance.refresh(); }',
    );

    expect(messages).toEqual([]);
  });

  it('passes a re-read two helpers deep: a helper\'s own helpers are not followed', () => {
    const messages = lines(
      'function rereadAll(tree) { tree.invalidate(); }',
      'function afterWrite(tree) { rereadAll(tree); }',
      'async function f(tree) { await appendPlugin(root, profile, name); afterWrite(tree); }',
    );

    expect(messages).toEqual([]);
  });

  it('passes a re-read through a method call: this.method() and obj.fn() are not followed', () => {
    const messages = lines(
      'const helpers = { rereadAll(tree) { tree.invalidate(); } };',
      'class P {',
      '  rereadAll() { this.tree.invalidate(); }',
      '  async f() { await appendPlugin(root, profile, name); this.rereadAll(); helpers.rereadAll(this.tree); }',
      '}',
    );

    expect(messages).toEqual([]);
  });

  it('passes a helper that neither writes nor re-reads', () => {
    const messages = lines(
      'function say(reporter) { reporter.landed("Tracked."); }',
      'async function f(client, reporter) { await client.track(x); say(reporter); }',
    );

    expect(messages).toEqual([]);
  });

  it('judges a nested function apart from the function around it', () => {
    const messages = lint('async function outer(c, t) { await c.track(x); async function inner() { await c.track(y); t.refresh(); } }\n');

    expect(messages).toHaveLength(1);
  });

  it('passes a re-read with no write beside it: setting the record filter is view state, not a write', () => {
    const messages = lint('async function setFilter(client, tree, refreshMatchingPlugins) { await client.setFilter(sql); tree.refresh(); refreshMatchingPlugins(); }\n');

    expect(messages).toEqual([]);
  });

  it('passes a write and a re-read in sibling functions: the drop writes, the instance subscription re-reads', () => {
    const messages = lines(
      'class Provider {',
      '  constructor(instance) { instance.subscribe(() => this.invalidate()); }',
      '  async handleDrop(names, drop) { await this.source.reorderPlugins(names, drop); }',
      '}',
    );

    expect(messages).toEqual([]);
  });

  it('passes a write that re-reads nothing', () => {
    const messages = lint('async function f(client, reporter) { await client.copyRecords(x); reporter.landed("Copied."); }\n');

    expect(messages).toEqual([]);
  });
});
