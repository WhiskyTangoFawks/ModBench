import type { InstanceValue } from '../instanceLoader/instance';
import { Refusal } from './instanceReads';

export interface ModName {
  name: string;
  kind?: 'mod' | 'separator';
}

type Entry = InstanceValue['mods'][number];

const asNamed = ({ kind, name }: Entry): string => `${kind} ${name}`;

function matchesOf(entries: readonly Entry[], { name, kind }: ModName): readonly Entry[] {
  return entries.filter((entry) => entry.name === name && (kind === undefined || entry.kind === kind));
}

function refusalFor(given: ModName, matches: readonly Entry[]): string | undefined {
  if (matches.length === 1) return undefined;
  if (matches.length === 0) return `Nothing is named "${given.name}"${given.kind === undefined ? '' : ` as a ${given.kind}`}.`;
  return `"${given.name}" means more than one thing: ${matches.map(asNamed).join('; ')}. Name it with its kind.`;
}

/** Each name as the Mods view shows it, or one refusal for every name that is not exactly one entry. */
export function modsNamed(entries: readonly Entry[], given: readonly ModName[]): Entry[] {
  const resolved = given.map((one) => ({ one, matches: matchesOf(entries, one) }));
  const refusals = resolved.flatMap(({ one, matches }) => refusalFor(one, matches) ?? []);
  if (refusals.length > 0) throw new Refusal(refusals.join(' '));
  return resolved.flatMap(({ matches }) => matches);
}
