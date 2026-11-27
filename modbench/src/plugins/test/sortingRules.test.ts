import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { DiagnosticSeverity, host } from './vscodeHost';
import { deferred, factsOver, settle, type Shown } from './pluginsOver';
import type { PluginMetadata } from '../../client';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import type { FileReads } from '../../sortingRules/lootConditions';
import { READ_SORTING_RULE_FILES } from '../../test/readSortingRuleFiles';

const A = { name: 'A.esp', origin: 'SomeMod' };
const B = { name: 'B.esp', origin: 'SomeMod' };
const USERLIST = '/instance/userlist.yaml';

const held = (overrides: Partial<PluginMetadata> = {}) => pluginMetadataFixture({ name: 'A.esp', ...overrides });
const texts = (collection: string) => host.problems(collection).flatMap(([, shown]) => shown.map(({ message }) => message));


function recordedReads(gates: Promise<void>[] = []) {
  const asked: { kind: string; path: string; trusted: boolean }[] = [];
  let trusted = false;
  const reads: FileReads = {
    checksum: (path) => { asked.push({ kind: 'checksum', path, trusted }); return Promise.resolve({ kind: 'read', value: undefined }); },
    version: (path) => { asked.push({ kind: 'version', path, trusted }); return Promise.resolve({ kind: 'read', value: undefined }); },
    readable: async (path) => {
      asked.push({ kind: 'readable', path, trusted });
      await gates.shift();
      return { kind: 'read', value: false };
    },
    trusting: async (read) => {
      trusted = true;
      try { return await read(); } finally { trusted = false; }
    },
  };
  return { reads, asked };
}

function judging(shown: readonly Shown[], { masterlist, userlist, gates }: { masterlist?: string; userlist?: string; gates?: Promise<void>[] } = {}) {
  const { reads, asked } = recordedReads(gates);
  const facts = factsOver(shown, {
    masterlist, userlist, fileReads: reads,
    value: { dataFolderPlugins: { kind: 'listed', names: new Set() }, dataFolderFiles: { kind: 'listed', files: new Map() } },
  });
  return {
    ...facts, asked,
    masterlistIs: async (text: string) => {
      facts.instance.publish({ ...facts.instance.value, sortingRuleFiles: { ...READ_SORTING_RULE_FILES, masterlist: { path: '/instance/masterlist.yaml', kind: 'text', text } } });
      await settle();
    },
  };
}

describe('the sorting rules, judged at a reconcile (plugins.md, Sorting rules)', () => {
  it('judges LOOT\'s rules with the game\'s: a requirement that is missing is a Sorting error', async () => {
    const facts = judging([A], { masterlist: 'plugins:\n  - name: A.esp\n    req: [Missing.esp]\n' });

    await facts.reconciled([held()]);

    expect(texts('modbench-sorting-errors')).toEqual(['"A.esp" requires "Missing.esp", which is missing.']);
  });

  it('holds a LOOT condition on a plugin\'s version against the description mEdit sends', async () => {
    const facts = judging([A], { masterlist: `plugins:
  - name: A.esp
    msg:
      - {type: say, content: Old., condition: 'version("A.esp", <, "2.0")'}
      - {type: say, content: New., condition: 'version("A.esp", >=, "2.0")'}
` });

    await facts.reconciled([held({ description: 'Patch v2.0.5' })]);

    expect(texts('modbench-sorting-info')).toEqual(['New.']);
  });

  it('reads is_master() and version() of the active plugin of a name, never of a disabled copy of it', async () => {
    const disabled = { name: 'A.esp', origin: 'Disabled', enabled: false };
    const facts = judging([A, disabled], { masterlist: `plugins:
  - name: A.esp
    msg:
      - {type: say, content: Master., condition: 'is_master("A.esp")'}
      - {type: say, content: Newer., condition: 'version("A.esp", >=, "2.0")'}
` });

    await facts.reconciled([held({ origin: 'Disabled', isMaster: true, description: 'v3.0' }), held({ isMaster: false, description: 'v1.0' })]);

    expect(texts('modbench-sorting-info')).toEqual([]);
  });

  it('asks for the file reads the conditions of the active plugins name, and the checksum of one with cleaning data', async () => {
    const facts = judging([A], { masterlist: `plugins:
  - name: A.esp
    msg: [{type: say, content: m, condition: 'readable("../G.exe")'}]
    dirty: [{crc: 0x1, util: u}]
  - name: Other.esp
    msg: [{type: say, content: m, condition: 'readable("../H.exe")'}]
` });

    await facts.reconciled([held()]);

    expect(facts.asked.map(({ kind, path }) => ({ kind, path }))).toEqual([{ kind: 'readable', path: '../G.exe' }, { kind: 'checksum', path: 'A.esp' }]);
  });

  it('shows a LOOT say message in the tooltip and the Problems panel at Info, and sets no icon or status', async () => {
    const facts = judging([A], { masterlist: 'plugins:\n  - name: A.esp\n    msg: [{type: say, content: Read the page.}]\n' });

    await facts.reconciled([held()]);

    const row = await facts.row('A.esp');
    expect([texts('modbench-sorting-info'), row?.icon, row?.description, row?.tooltip.at(-1)]).toEqual([['Read the page.'], undefined, undefined, 'Info: Read the page.']);
  });

  it('judges a group order within the master flag\'s partitions: an ungrouped master loading after a plugin of a later group is not broken', async () => {
    const master = { name: 'M.esm', origin: 'SomeMod' };
    const facts = judging([A, master], { masterlist: 'groups:\n  - name: default\n  - {name: fixes, after: [default]}\nplugins:\n  - {name: A.esp, group: fixes}\n' });

    await facts.reconciled([held(), held({ name: 'M.esm', isMaster: true })]);

    expect(texts('modbench-sorting-info')).toEqual([]);
  });

  it('puts one group problem on the one plugin outside its group, and offers its move, however many plugins it passes', async () => {
    const order = [A, ...['B.esp', 'C.esp', 'D.esp'].map((name) => ({ name, origin: 'SomeMod' }))];
    const facts = judging(order, { masterlist: 'groups:\n  - name: default\n  - {name: fixes, after: [default]}\nplugins:\n  - {name: A.esp, group: fixes}\n' });

    await facts.reconciled(order.map(({ name }) => held({ name })));

    expect([host.problems('modbench-sorting-info').map(([path]) => path), facts.agent.suggestedMoves().map(({ mover, drop }) => [mover.name, drop])]).toEqual([
      ['/mods/SomeMod/A.esp'], [['A.esp', { kind: 'after', name: 'D.esp' }]],
    ]);
  });

  it('publishes a rule the userlist states on its line in the userlist', async () => {
    const facts = judging([A], { userlist: 'plugins:\n  - name: A.esp\n    req: [B.esp]\n' });

    await facts.reconciled([held()]);

    expect(host.problems('modbench-sorting-rule-files').map(([path, shown]) => [path, shown.map(({ message, severity }) => [message, severity])]))
      .toEqual([[USERLIST, [['"A.esp" requires "B.esp", which is missing.', DiagnosticSeverity.Error]]]]);
  });

  it('judges the order of the last reconcile again when the rules change, and not before one', async () => {
    const facts = judging([A]);
    await facts.masterlistIs('plugins:\n  - name: A.esp\n    req: [Missing.esp]\n');
    const beforeReconcile = texts('modbench-sorting-errors');

    await facts.reconciled([held()]);
    const atTheReconcile = texts('modbench-sorting-errors');
    await facts.masterlistIs('plugins: []\n');

    expect([beforeReconcile, atTheReconcile, texts('modbench-sorting-errors')]).toEqual([[], ['"A.esp" requires "Missing.esp", which is missing.'], []]);
  });
});

describe('judging again as the facts are re-read', () => {
  const reads = (bIsMaster: boolean) => [held(), held({ name: 'B.esp', isMaster: bIsMaster })];
  const READ_G = "plugins:\n  - name: A.esp\n    msg: [{type: say, content: m, condition: 'readable(\"../G.exe\")'}]\n";

  it.each([
    ['raises the error a re-read master flag causes', false, [[], ['B.esp']]],
    ['clears the error a re-read dropped master flag leaves', true, [['B.esp'], []]],
  ])('%s', async (_, masterAtReconcile, raised) => {
    const facts = judging([A, B]);
    await facts.reconciled(reads(masterAtReconcile));
    const atTheReconcile = host.problems('modbench-sorting-errors').map(([path]) => path.replace('/mods/SomeMod/', ''));

    await facts.changed(reads(!masterAtReconcile));

    expect([atTheReconcile, host.problems('modbench-sorting-errors').map(([path]) => path.replace('/mods/SomeMod/', ''))]).toEqual(raised);
  });

  it('judges again no more than a change to what the sorting rules judge, and names the plugins it was asked about', async () => {
    const facts = judging([A, B], { masterlist: READ_G });
    await facts.reconciled(reads(false));
    facts.asked.length = 0;
    const redrawn: unknown[] = [];
    facts.view().treeDataProvider.onDidChangeTreeData?.((row) => redrawn.push(row));

    await facts.changed([held({ isCompiledPlugin: true }), ...reads(false).slice(1)], [A]);

    const row = await facts.pluginRows();
    expect([facts.asked, new Set(redrawn)]).toEqual([[], new Set([row('A.esp', 'SomeMod')])]);
  });

  it('names the plugins asked about and the plugins whose judgement the re-read altered', async () => {
    const facts = judging([A, B]);
    await facts.reconciled([held({ isMaster: true }), held({ name: 'B.esp', isMaster: true })]);
    const redrawn: unknown[] = [];
    facts.view().treeDataProvider.onDidChangeTreeData?.((row) => redrawn.push(row));

    await facts.changed([held({ isMaster: false })], [A]);

    const row = await facts.pluginRows();
    expect(new Set(redrawn)).toEqual(new Set([row('A.esp', 'SomeMod'), row('B.esp', 'SomeMod')]));
  });

  it('judges again from the reads it kept, trusting them, and checks each file at a reconcile', async () => {
    const facts = judging([A], { masterlist: READ_G });
    await facts.reconciled([held()]);

    await facts.masterlistIs(`${READ_G}\n`);

    const [atTheReconcile, ...judgingAgain] = facts.asked.map(({ trusted }) => trusted);
    expect([atTheReconcile, judgingAgain.length > 0 && judgingAgain.every(Boolean)]).toEqual([false, true]);
  });

  it('judges again for an edited description, which a version condition of the sorting rules reads', async () => {
    const facts = judging([A, B], { masterlist: READ_G });
    await facts.reconciled(reads(false));
    facts.asked.length = 0;

    await facts.changed([held({ description: 'edited' }), ...reads(false).slice(1)], [A]);

    expect(facts.asked).toHaveLength(1);
  });

  it('judges again when mEdit\'s answer for a named plugin leaves it out', async () => {
    const facts = judging([A, B]);
    await facts.reconciled(reads(true));
    const atTheReconcile = texts('modbench-sorting-errors').length;

    await facts.changed([], [B]);

    expect([atTheReconcile, texts('modbench-sorting-errors')]).toEqual([1, []]);
  });

  it('judges nothing before the first reconcile', async () => {
    const facts = judging([A, B]);
    await facts.indexed({ indexed: [A, B] });

    await facts.changed(reads(true));

    expect(texts('modbench-sorting-errors')).toEqual([]);
  });
});

describe('judging again as the rules change while a judgement is in flight', () => {
  const SAYS_ON_G = "    msg: [{type: say, content: m, condition: 'readable(\"../G.exe\")'}]\n";
  const NO_RULES = `plugins:\n  - name: A.esp\n${SAYS_ON_G}`;
  const MISSING = `plugins:\n  - name: A.esp\n    req: [Missing.esp]\n${SAYS_ON_G}`;
  const redrawsOf = (facts: ReturnType<typeof judging>) => {
    const redrawn: unknown[] = [];
    facts.view().treeDataProvider.onDidChangeTreeData?.((row) => redrawn.push(row));
    return redrawn;
  };
  const errors = () => texts('modbench-sorting-errors').length;

  it('publishes the newest judgement, never an older one that resolves after it', async () => {
    const older = deferred<undefined>();
    const facts = judging([A], { masterlist: NO_RULES, gates: [Promise.resolve(), older.promise] });
    await facts.reconciled([held()]);
    await facts.masterlistIs(MISSING);
    await facts.masterlistIs(NO_RULES);
    const redrawn = redrawsOf(facts);

    older.resolve(undefined);
    await settle();

    expect([errors(), redrawn]).toEqual([0, []]);
  });

  it('drops a judgement of the old order that resolves after a reconcile landed the new one', async () => {
    const slow = deferred<undefined>();
    const master = { name: 'M.esp', origin: 'SomeMod' };
    const facts = judging([{ ...master, enabled: false }, A], { masterlist: NO_RULES, gates: [Promise.resolve(), slow.promise] });
    const both = [held({ masters: ['M.esp'] }), held(master)];
    await facts.reconciled(both);
    await facts.masterlistIs(`${NO_RULES}\n`);
    const { value } = facts.instance;
    facts.instance.publish({ ...value, plugins: value.plugins.map((plugin) => ({ ...plugin, enabled: true })) }, { named: [], disk: false });
    await facts.reconciled(both);
    const redrawn = redrawsOf(facts);

    slow.resolve(undefined);
    await settle();

    expect([errors(), redrawn]).toEqual([0, []]);
  });

  it('judges a reconcile by the rules that stand when its reads land', async () => {
    const slow = deferred<undefined>();
    const facts = judging([A], { masterlist: NO_RULES, gates: [slow.promise] });
    await facts.reconciled([held()]);
    await facts.masterlistIs(MISSING);

    slow.resolve(undefined);
    await settle();

    expect(errors()).toBe(1);
  });
});
