import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import { noRereadAfterPluginsWrite } from '../../eslint-rules/noRereadAfterPluginsWrite.mjs';

const MESSAGE =
  'A Plugins write writes its file and returns. The view changes only when the watch reads the file '
  + "back: the Instance loader's next value for plugins.txt, mEdit's published rows for plugin source. "
  + 'A write path never refreshes or invalidates the view, landed or failed (ADR-0015 invariant 2).';

function lint(code: string): Linter.LintMessage[] {
  const linter = new Linter();
  return linter.verify(code, {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    plugins: { local: { rules: { x: noRereadAfterPluginsWrite } } },
    rules: { 'local/x': 'error' },
  });
}

const WRITES = [
  'setPluginsParticipation', 'setPluginsEnabled', 'reorderPlugins', 'appendPlugin', 'onPluginCheckboxChanged',
  'createPlugin', 'track', 'createRecord', 'deleteRecords', 'copyRecords',
];

const REREADS = ['invalidate', 'refresh', 'refreshFacts', 'refreshMatchingPlugins', 'refreshTree'];

describe('no-reread-after-plugins-write', () => {
  it('fails a planted invalidate after a plugins.txt write, with the rule\'s own message', () => {
    const messages = lint('async function f(tree) { await setPluginsParticipation(root, entries); tree.invalidate(); }\n');

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toBe(MESSAGE);
  });

  it.each(WRITES)('fails a refresh beside the %s write', (write) => {
    const messages = lint(`async function f(client, tree) { await client.${write}(x); tree.refresh(); }\n`);

    expect(messages).toHaveLength(1);
  });

  it.each(REREADS)('fails %s beside a write', (reread) => {
    const messages = lint(`async function f(client, tree) { await client.createRecord(x); tree.${reread}(); }\n`);

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
