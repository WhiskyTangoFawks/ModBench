import { describe, expect, it } from 'vitest';
import { columnStatuses, copyStatus, type Standing } from '../columnStatus';

const NO_STANDING: Standing = { overriddenBy: null, notActive: false };

const WHY = { reason: 'plugin-source holds no folder for MyMod.esp.', decompileRepairs: true };
const TWINS = { reason: 'plugin-source holds FIXTURE.ESP and fixture.esp, which differ only in case.', decompileRepairs: false };
const DIAGNOSIS = 'the PERK entry point did not have expected parameter type flag';

const COPY = { plugin: 'MyMod.esp', origin: 'ModA', isPartialForm: false, isInOverwrite: false };
const COMPILED = { name: 'MyMod.esp', origin: 'ModA', isCompiledPlugin: true };

interface Facts {
  copy?: Partial<typeof COPY & { parseDiagnosis: string }>;
  plugin?: Partial<typeof COMPILED & { isImmutable: boolean; pluginSourceUnreadable: typeof WHY }>;
  standing?: Partial<Standing>;
}

const statusOf = ({ copy, plugin, standing }: Facts = {}) =>
  copyStatus({ ...COPY, ...copy }, { ...COMPILED, ...plugin }, { ...NO_STANDING, ...standing });

describe('a column\'s status', () => {
  it.each<[string, Facts, string, string]>([
    ['a copy mEdit could not read', { copy: { parseDiagnosis: DIAGNOSIS } }, '(parse failure)', DIAGNOSIS],
    ['a plugin another mod’s file of its name overrides', { standing: { overriddenBy: 'ModB' } }, '(overridden)', 'The game loads ModB’s file instead.'],
    ['a plugin the game does not load', { standing: { notActive: true } }, '(not active)', 'The game does not load it, so no other copy is compared.'],
    ['the game’s own plugin', { plugin: { isImmutable: true } }, '(read-only)', 'The game’s plugins are not edited.'],
    ['a plugin in Overwrite', { copy: { isInOverwrite: true }, plugin: { isCompiledPlugin: false } }, '(read-only)',
      'Overwrite is not a mod; move the plugin into a mod and decompile and commit that mod.'],
    ['a plugin that is not a compiled plugin', { plugin: { isCompiledPlugin: false } }, '(read-only)',
      '“Decompile and Commit Mod”, or “Decompile Plugin” in a source mod, in this header’s menu, makes it editable.'],
    ['a compiled plugin whose plugin source is unreadable', { plugin: { pluginSourceUnreadable: WHY } }, '(read-only)',
      `${WHY.reason} Its records are its plugin file’s. “Decompile Plugin”, in this header’s menu, makes it editable.`],
    ['a compiled plugin whose plugin source decompile does not repair', { plugin: { pluginSourceUnreadable: TWINS } }, '(read-only)',
      `${TWINS.reason} Its records are its plugin file’s.`],
    ['a Partial Form copy', { copy: { isPartialForm: true } }, '(Partial Form)', 'The game ignores this copy’s own fields.'],
  ])('for %s, is its label and reason', (_case, facts, label, reason) => {
    expect(statusOf(facts)).toEqual({ label, reason });
  });

  it.each<[string, Facts, string]>([
    ['parse failure over read-only', { copy: { parseDiagnosis: DIAGNOSIS }, plugin: { isImmutable: true } }, '(parse failure)'],
    ['parse failure over not active', { copy: { parseDiagnosis: DIAGNOSIS }, standing: { notActive: true } }, '(parse failure)'],
    ['parse failure over overridden', { copy: { parseDiagnosis: DIAGNOSIS }, standing: { overriddenBy: 'ModB' } }, '(parse failure)'],
    ['overridden over read-only', { standing: { overriddenBy: 'ModB' }, plugin: { isImmutable: true } }, '(overridden)'],
    ['not active over read-only', { standing: { notActive: true }, plugin: { isImmutable: true } }, '(not active)'],
    ['Partial Form over read-only', { copy: { isPartialForm: true }, plugin: { isImmutable: true } }, '(Partial Form)'],
    ['Partial Form over no source', { copy: { isPartialForm: true }, plugin: { isCompiledPlugin: false } }, '(Partial Form)'],
  ])('is the first that applies: %s', (_case, facts, label) => {
    expect(statusOf(facts)?.label).toBe(label);
  });

  it('is none for a copy the game uses and I can edit', () => {
    expect(statusOf()).toBeNull();
  });

  it('reads a plugin the instance does not list as one nothing edits', () => {
    expect(copyStatus(COPY, undefined, NO_STANDING)?.label).toBe('(read-only)');
  });

  it('gives the standing to the tab\'s own file column alone, matching a plugin by origin as well as name', () => {
    const copies = [COPY, { ...COPY, origin: 'ModB', column: 'MyMod.esp|ModB' }];
    const plugins = [COMPILED, { ...COMPILED, origin: 'ModB', isImmutable: true }];

    const statuses = columnStatuses(copies, plugins, { column: 'MyMod.esp|ModA', standing: { overriddenBy: 'ModC', notActive: false } });

    expect(Object.fromEntries(Object.entries(statuses).map(([column, { label }]) => [column, label])))
      .toEqual({ 'MyMod.esp|ModA': '(overridden)', 'MyMod.esp|ModB': '(read-only)' });
  });
});
