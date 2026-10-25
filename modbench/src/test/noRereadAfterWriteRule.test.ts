import { noRereadAfterWrite, WRITES, VIEW_REREADS } from '../../eslint-rules/noRereadAfterWrite.mjs';
import { RuleTester } from './ruleTester';

const MESSAGE =
  "A write writes its file and returns. A view changes only when a read lands: the Instance loader's, which "
  + "runWritingGesture asks for once the command ends, or mEdit's published rows for plugin source. "
  + 'A write path never refreshes or invalidates a view itself, landed or failed (ADR-0015).';

const lines = (...source: string[]) => source.join('\n');
const fails = (name: string, code: string, line?: number) => ({ name, code, errors: [{ message: MESSAGE, ...(line === undefined ? {} : { line }) }] });

new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } }).run('no-reread-after-write', noRereadAfterWrite, {
  valid: [
    { name: 'a write run through runWritingGesture', code: 'async function f(commands, instance) { await commands.decompileAndCommit(x); await runWritingGesture(view, instance, noop); }\n' },
    {
      name: 'an anonymous export default function, which no name can call',
      code: lines('export default function (tree) { tree.invalidate(); }', 'async function f(client) { await client.decompileAndCommit(x); }'),
    },
    { name: 'a re-read in an inline function passed to a call that is not a write', code: 'function build(view, tree) { view.onDidChangeSelection(() => tree.refresh()); onPluginCheckboxChanged(e, root); }\n' },
    {
      name: 'a re-read in a function that only defines a callback which writes, written inline',
      code: 'function build(view, instance) { view.onDidChangeCheckboxState((e) => onPluginCheckboxChanged(e, root)); instance.refresh(); }\n',
    },
    {
      name: 'a re-read in a function that calls a helper which only defines a callback that writes',
      code: lines(
        'function registerView(view, root) { view.onDidChangeCheckboxState((e) => onPluginCheckboxChanged(e, root)); }',
        'function build(view, instance) { registerView(view, root); instance.refresh(); }',
      ),
    },
    {
      name: 'a re-read two helpers deep: a helper\'s own helpers are not followed',
      code: lines(
        'function rereadAll(tree) { tree.invalidate(); }',
        'function afterWrite(tree) { rereadAll(tree); }',
        'async function f(tree) { await appendPlugin(root, profile, name); afterWrite(tree); }',
      ),
    },
    {
      name: 'a re-read through a method call: this.method() and obj.fn() are not followed',
      code: lines(
        'const helpers = { rereadAll(tree) { tree.invalidate(); } };',
        'class P {',
        '  rereadAll() { this.tree.invalidate(); }',
        '  async f() { await appendPlugin(root, profile, name); this.rereadAll(); helpers.rereadAll(this.tree); }',
        '}',
      ),
    },
    {
      name: 'a helper that neither writes nor re-reads',
      code: lines(
        'function say(reporter) { reporter.landed("Initialized."); }',
        'async function f(client, reporter) { await client.decompileAndCommit(x); say(reporter); }',
      ),
    },
    {
      name: 'a re-read with no write beside it: setting the record filter is view state, not a write',
      code: 'async function setFilter(client, tree, refreshMatchingPlugins) { await client.setFilter(sql); tree.refresh(); refreshMatchingPlugins(); }\n',
    },
    {
      name: 'a write and a re-read in sibling functions: the drop writes, the instance subscription re-reads',
      code: lines(
        'class Provider {',
        '  constructor(instance) { instance.subscribe(() => this.invalidate()); }',
        '  async handleDrop(names, drop) { await this.source.reorderPlugins(names, drop); }',
        '}',
      ),
    },
    { name: 'a write that re-reads nothing', code: 'async function f(client, reporter) { await client.decompileAndCommit(x); reporter.landed("Copied."); }\n' },
  ],
  invalid: [
    fails('an invalidate after a plugins.txt write', 'async function f(tree) { await setPluginsParticipation(root, entries); tree.invalidate(); }\n'),
    ...[...WRITES].map((write) => fails(`a refresh beside the ${write} write`, `async function f(client, tree) { await client.${write}(x); tree.refresh(); }\n`)),
    ...[...VIEW_REREADS].map((reread) => fails(`${reread} beside a write`, `async function f(client, view) { await client.applyWorkspaceChanges(x); view.${reread}(); }\n`)),
    fails(
      'an instance refresh beside the write inside runWritingGesture',
      'function f(commands, instance) { return runWritingGesture(view, instance, async () => { await commands.decompileAndCommit(x); instance.refresh(); }); }\n',
    ),
    fails('a tree-data event fired straight after a drop\'s write', 'async function handleDrop(names, drop) { await this.source.reorderPlugins(names, drop); this._onDidChangeTreeData.fire(undefined); }\n'),
    fails('a re-read the write path was handed as a bare function', 'async function f(invalidate) { const r = await setPluginsParticipation(x); if (!r.applied) invalidate(); }\n'),
    fails('the call of a closure that re-reads, made by the command callback that writes', lines(
      'function register(client, treeSync, refreshMatchingPlugins) {',
      '  const onWritten = () => { treeSync.refresh(); refreshMatchingPlugins(); };',
      '  return registerCommand(async () => { await client.applyWorkspaceChanges(x); onWritten(); });',
      '}',
    ), 3),
    fails(
      'a view refresh after a create applies its workspace changes through the source editing port',
      'async function create(deps, tree) { await deps.source.applyWorkspaceChanges([changes]); tree.refresh(); }\n',
    ),
    fails('the call of a module-level helper that re-reads, made after a write', lines(
      'function refreshAfterWrite(deps) { deps.refreshTree(); deps.refreshMatchingPlugins(); }',
      'async function dispatchDecompileAndCommit(deps, mods) { await deps.commands.decompileAndCommit(mods); refreshAfterWrite(deps); }',
    ), 2),
    fails('the call of a helper declared after the function that calls it', lines(
      'async function dispatchDecompileAndCommit(deps, mods) { await deps.commands.decompileAndCommit(mods); refreshAfterWrite(deps); }',
      'function refreshAfterWrite(deps) { deps.refreshTree(); }',
    )),
    fails('the call of an arrow helper that re-reads, made after a write', lines(
      'const rereadAll = (tree) => tree.invalidate();',
      'async function f(tree) { await appendPlugin(root, profile, name); rereadAll(tree); }',
    )),
    fails('the call of a function-expression helper that re-reads, made after a write', lines(
      'const rereadAll = function (tree) { tree.invalidate(); };',
      'async function f(tree) { await appendPlugin(root, profile, name); rereadAll(tree); }',
    )),
    fails('the call of an export default function helper that re-reads, made after a write', lines(
      'export default function rereadAll(tree) { tree.invalidate(); }',
      'async function f(tree) { await appendPlugin(root, profile, name); rereadAll(tree); }',
    )),
    fails('a re-read beside the call of a helper that writes', lines(
      'async function appendCreated(root, name) { await appendPlugin(root, "Default", name); }',
      'async function create(tree) { await appendCreated(root, name); tree.invalidate(); }',
    )),
    fails('a re-read chained on a write with .then, as part of the caller', 'async function f(client, tree) { await client.applyWorkspaceChanges(x).then(() => tree.refresh()); }\n'),
    fails(
      'a re-read chained on a write with .finally, past a .then, as part of the caller',
      'function f(client, tree) { return client.decompileAndCommit(x).then(report).finally(() => tree.invalidate()); }\n',
    ),
    fails('a re-read in an inline function passed to a write, as part of the caller', 'async function f(tree) { await setPluginsParticipation(x, () => tree.refresh()); }\n'),
    fails('a re-read chained on a same-file helper that writes', lines(
      'async function appendCreated(root, name) { await appendPlugin(root, "Default", name); }',
      'function create(tree) { return appendCreated(root, name).then(() => tree.invalidate()); }',
    )),
    fails(
      'a nested function judged apart from the function around it',
      'async function outer(c, t) { await c.decompileAndCommit(x); async function inner() { await c.decompileAndCommit(y); t.refresh(); } }\n',
    ),
  ],
});
