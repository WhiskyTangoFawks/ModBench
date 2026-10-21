import { describe, it, expect } from 'vitest';
import { IN_AN_INSTANCE, holds, requires } from './manifest';

const GATE = IN_AN_INSTANCE;

describe('requires', () => {
  it.each<[string, string | undefined, boolean]>([
    ['a top-level conjunct', `view == modbench.modList && ${GATE}`, true],
    ['a negated gate', `view == modbench.modList && !${GATE}`, false],
    ['an alternative of the gate', `view == modbench.modList || ${GATE}`, false],
    ['no gate at all', 'view == modbench.modList', false],
    ['no clause', undefined, false],
    ['a conjunct of every alternative', `view == a && ${GATE} || view == b && ${GATE}`, true],
    ['a conjunct of only one alternative', `view == a && ${GATE} || view == b`, false],
    ['a conjunct beside a parenthesised alternative', `${GATE} && (view == a || view == b)`, true],
    ['a conjunct of every parenthesised alternative', `(view == a && ${GATE}) || (view == b && ${GATE})`, true],
    ['an alternative regrouped by parentheses', `(view == a || ${GATE}) && view == b`, false],
    ['a parenthesised negation', `!(${GATE}) && view == a`, false],
    ['a conjunct beside a negated regex group', String.raw`${GATE} && !(viewItem =~ /\b(a|b)\b/)`, true],
  ])('%s', (_case, when, expected) => {
    expect(requires(when, GATE)).toBe(expected);
  });

  it.each([
    ['an unclosed parenthesis', `${GATE} && (view == a`],
    ['an unopened parenthesis', `${GATE} && view == a)`],
  ])('refuses %s, rather than reading it as ungated', (_case, when) => {
    expect(() => requires(when, GATE)).toThrow(/cannot read/);
  });
});

describe('holds', () => {
  const on = { view: 'modbench.pluginListTree', viewItem: 'plugin compilable' };

  it.each<[string, string, Record<string, string | boolean>, boolean]>([
    ['every conjunct of an && holds', String.raw`view == modbench.pluginListTree && viewItem =~ /\bcompilable\b/`, on, true],
    ['one conjunct of an && fails', String.raw`view == modbench.pluginListTree && viewItem =~ /\bnonCompiledPluginInMod\b/`, on, false],
    ['the second alternative of an || holds', 'viewItem == other || view == modbench.pluginListTree', on, true],
    ['no alternative of an || holds', 'viewItem == other || view == other', on, false],
    ['a ! inverts a matching group', String.raw`view == modbench.pluginListTree && !(viewItem =~ /\bcompilable\b/)`, on, false],
    ['a ! inverts a failing group', String.raw`view == modbench.pluginListTree && !(viewItem =~ /\bnonCompiledPluginInMod\b/)`, on, true],
    ['a ! on an unset key holds', '!compilable', {}, true],
    ['a ! on a set key fails', '!compilable', { compilable: true }, false],
    ['&& binds tighter than ||', 'view == other && viewItem == other || viewItem == plugin compilable', on, true],
    ['parentheses regroup an &&', 'view == other && (viewItem == other || viewItem == plugin compilable)', on, false],
    ['a quoted operand and a set key hold', "webviewId == 'modbench' && compilable", { webviewId: 'modbench', compilable: true }, true],
    ['an unset key fails', "webviewId == 'modbench' && compilable", { webviewId: 'modbench' }, false],
  ])('%s', (_case, when, context, expected) => {
    expect(holds(when, context)).toBe(expected);
  });
});
