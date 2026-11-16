import type { components } from '../wire/generated/api';
import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';

type KnownResult = components['schemas']['KnownResult'];
type RecordResult = components['schemas']['RecordResult'];

export interface HeldAnswer {
  plugin: PluginAddress;
  failure?: string | null;
  records?: RecordResult[] | null;
}

/** How an answer divides into its records' parts and the plugin's own level, as pull diagnostics divide a workspace's. */
export interface Division<A extends HeldAnswer, Part> {
  partOf: (answer: A, record: RecordResult) => Part;
  isEmpty: (part: Part) => boolean;
  levelOf: (answer: A) => string;
  join: (answer: A, parts: ReadonlyMap<string, Part>) => A;
}

interface Held<A, Part> { answer: A; parts: Map<string, { resultId: string; part: Part }>; level: string }

/** An unchanged record whose held result is not the one asked with. */
export const STALE = Symbol('stale');

export type HeldResults<A extends HeldAnswer, Part> = ReturnType<typeof heldResults<A, Part>>;

/** One read's answers as held per plugin and record. An answer that changes nothing merges to the held answer, the same object. */
export function heldResults<A extends HeldAnswer, Part>(division: Division<A, Part>) {
  const held = new Map<string, Held<A, Part>>();
  const keyOf = (plugin: PluginAddress, formKey: string) => `${pluginAddressKey(plugin)}\n${formKey}`;

  const known = (plugin?: PluginAddress): KnownResult[] => [...held.values()]
    .filter(({ answer }) => plugin === undefined || pluginAddressKey(answer.plugin) === pluginAddressKey(plugin))
    .flatMap(({ answer, parts }) => [...parts].map(([formKey, { resultId }]) => ({ plugin: answer.plugin, formKey, resultId })));

  const holds = (plugin: PluginAddress): boolean => held.has(pluginAddressKey(plugin));

  const mergeOne = (answer: A, sent: ReadonlyMap<string, string>, keyed: boolean): A | typeof STALE => {
    const key = pluginAddressKey(answer.plugin);
    const before = held.get(key);
    if (answer.failure != null) { held.delete(key); return answer; }
    const parts = new Map(keyed ? before?.parts : []);
    for (const record of answer.records ?? []) {
      if (record.unchanged) {
        const stands = before?.parts.get(record.formKey);
        if (stands === undefined || stands.resultId !== sent.get(keyOf(answer.plugin, record.formKey))) return STALE;
        parts.set(record.formKey, stands);
        continue;
      }
      const part = division.partOf(answer, record);
      if (division.isEmpty(part)) parts.delete(record.formKey);
      else parts.set(record.formKey, { resultId: record.resultId, part });
    }
    const level = division.levelOf(answer);
    const same = before !== undefined && before.level === level && before.parts.size === parts.size
      && [...parts].every(([formKey, { resultId }]) => before.parts.get(formKey)?.resultId === resultId);
    if (same) return before.answer;
    const next = division.join(answer, new Map([...parts].map(([formKey, { part }]) => [formKey, part])));
    held.set(key, { answer: next, parts, level });
    return next;
  };

  const merge = (answers: readonly A[], asked: readonly KnownResult[], plugin: PluginAddress | undefined, keyed: boolean): A[] | typeof STALE => {
    const sent = new Map(asked.map((result) => [keyOf(result.plugin, result.formKey), result.resultId]));
    const merged: A[] = [];
    for (const answer of answers) {
      const one = mergeOne(answer, sent, keyed);
      if (one === STALE) return STALE;
      merged.push(one);
    }
    const answered = new Set(answers.map(({ plugin: each }) => pluginAddressKey(each)));
    for (const key of held.keys()) if (!answered.has(key) && (plugin === undefined || key === pluginAddressKey(plugin))) held.delete(key);
    return merged;
  };

  return { known, holds, merge };
}
