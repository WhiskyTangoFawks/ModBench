import type { LoadOrderRefusal, NotificationPayloads, PluginAddress, PluginDiagnosisReport, PluginLoadFailure, PluginMetadata } from '../client';
import type { UnreadableSource } from '../wire/unreadableSource';
import { OVERWRITE_ORIGIN, pluginAddressKey } from '../wire/pluginAddress';
import { pluginOriginName } from '../instanceLoader/pluginStanding';
import { pluginCanBeEdited } from '../wire/pluginEditable';
import { ByPluginAddress } from './pluginAddress';
import type { PluginConditions } from '../drivingLib/recordRowContext';

/** A diagnostic on one plugin's file, as the Problems panel shows it. */
export type PluginProblem = Pick<PluginDiagnosisReport, 'plugin' | 'origin' | 'text'>;

type StatusKind = 'notRestored' | 'failedToRead' | 'masterIssues' | 'unreadableRecords' | 'sourceUnreadable' | 'changedOutside' | 'malformed';

export interface PluginStatus {
  kind: StatusKind;
  words: string;
  tooltipLine: string;
}

export type StatusIcon = 'error' | 'warning';

export type PluginPlace = 'inSourceMod' | 'inNonSourceMod' | 'inOverwrite';

/** The instance value's two facts about where a mod's plugins live. */
export interface PlaceFacts {
  readonly modOfOrigin: (origin: string) => string | undefined;
  readonly listedSourceMods: ReadonlySet<string>;
}

// A read of mEdit's facts beside the load order's own: its failure, and whether it ever answered.
interface FactsRead {
  readonly what: string;
  failure?: string;
  answered: boolean;
}

/** What a plugin row expands into: its records, the error row naming why not, or the still-indexing row. */
export type Expansion = { kind: 'records' } | { kind: 'error'; message: string } | { kind: 'indexing' };

// `everyRow`: another window holds the instance (ADR-0010). `unheldRow`: mEdit unreachable, or the
// snapshot's index failed.
type ExpansionOverride = { scope: 'everyRow' | 'unheldRow'; message: string };

const WARNING_KINDS: ReadonlySet<StatusKind> = new Set(['notRestored', 'sourceUnreadable', 'changedOutside', 'malformed']);

const CHANGED_OUTSIDE_TEXT = 'Changed outside Modbench: its bytes differ from what Modbench last wrote.';

interface PluginRead {
  readOnly: boolean;
  compiledPlugin: boolean;
  sourceUnreadable: UnreadableSource | undefined;
  masters: readonly string[];
  missingMasters?: string[];
  lateMasters?: string[];
  parseFailure: boolean;
}

// plugins.md, A row, Plugin: each status's words and tooltip line.
const notRestored = (mod: string | undefined): PluginStatus | undefined => mod === undefined ? undefined
  : { kind: 'notRestored', words: 'not restored', tooltipLine: 'Not restored: its mod\'s manifest names it, and the mod\'s folder lacks it.' };

const failedToRead = (reason: string | undefined): PluginStatus | undefined => reason === undefined ? undefined
  : { kind: 'failedToRead', words: 'failed to read', tooltipLine: `Failed to read: ${reason}` };

// "Missing" is the reference tool's word for a master that is not active, file present or not.
const masterIssues = (missingMasters: readonly string[], lateMasters: readonly string[]): PluginStatus | undefined => {
  const count = missingMasters.length + lateMasters.length;
  if (count === 0) return undefined;
  const lines = [
    ...missingMasters.length === 0 ? [] : [`Missing masters: ${missingMasters.join(', ')}`],
    ...lateMasters.length === 0 ? [] : [`Masters loading after it: ${lateMasters.join(', ')}`],
  ];
  return { kind: 'masterIssues', words: count === 1 ? '1 master issue' : `${count} master issues`, tooltipLine: lines.join('; ') };
};

const unreadableRecords = (held: boolean): PluginStatus | undefined => !held ? undefined
  : {
    kind: 'unreadableRecords', words: 'unreadable records',
    tooltipLine: 'This plugin holds a record that could not be read into its document.',
  };

const sourceUnreadable = (unreadable: UnreadableSource | undefined): PluginStatus | undefined => unreadable === undefined ? undefined
  : {
    kind: 'sourceUnreadable', words: 'plugin source unreadable',
    tooltipLine: `Plugin source unreadable: ${unreadable.reason} Its records are those of its plugin file`
      + (unreadable.decompileRepairs ? ', until decompile writes its source.' : '.'),
  };

const changedOutside = (changed: boolean): PluginStatus | undefined => !changed ? undefined
  : { kind: 'changedOutside', words: 'changed outside Modbench', tooltipLine: CHANGED_OUTSIDE_TEXT };

const malformed = (diagnosisTexts: readonly string[]): PluginStatus | undefined => diagnosisTexts.length === 0 ? undefined
  : { kind: 'malformed', words: 'malformed', tooltipLine: `Malformed: ${diagnosisTexts.join('; ')}` };

export function placeOf(origin: string, { modOfOrigin, listedSourceMods }: PlaceFacts): PluginPlace | undefined {
  if (origin === OVERWRITE_ORIGIN) return 'inOverwrite';
  const mod = modOfOrigin(origin);
  if (mod === undefined) return undefined;
  return listedSourceMods.has(mod) ? 'inSourceMod' : 'inNonSourceMod';
}

/** mEdit's answers about each plugin, joined by (origin, filename), and the status each row
 *  shows from them (plugins.md, A row). */
export class PluginFacts {
  private held = new ByPluginAddress<true>();
  private reads = new ByPluginAddress<PluginRead>();
  private matches?: ByPluginAddress<boolean>;
  private diagnosisTexts = new ByPluginAddress<string[]>();
  private diagnosisReports: PluginDiagnosisReport[] = [];
  private readonly changedByMod = new Map<string, readonly PluginAddress[]>();
  private changed = new ByPluginAddress<true>();
  private notRestoredFrom = new ByPluginAddress<string>();
  // Row status only, no blink: merges across a reload's ticks and persists until `reconciled`
  // lands the new answer.
  private loadFailures = new ByPluginAddress<PluginLoadFailure>();
  // Children expansion only: this reload's own ticks, replaced wholesale each time, so a plugin
  // not yet reached reads as still indexing, never a stale failure from before the reload began.
  private reachableFailures = new ByPluginAddress<PluginLoadFailure>();
  private expansionOverride?: ExpansionOverride;
  private indexFailure?: string;
  private noMatchAnywhere = false;
  private laterFailures = new Map<string, string>();
  private readonly factsRead: FactsRead = { what: "mEdit's facts about each plugin", answered: false };
  private readonly scanRead: FactsRead = { what: 'the malformed-plugin scan', answered: false };

  /** A progressive reconcile's tick. */
  indexed(plugins: readonly PluginAddress[], failures: readonly PluginLoadFailure[]): void {
    this.held = heldSet(plugins);
    this.reachableFailures = indexLoadFailures(failures);
    indexLoadFailures(failures, this.loadFailures);
    this.clearOverride();
  }

  /** The load order's own refusal (ADR-0010). */
  refused(refusal: LoadOrderRefusal): void {
    this.indexFailure = refusal.kind === 'failed' ? refusal.message : undefined;
    this.expansionOverride = { scope: refusal.kind === 'heldElsewhere' ? 'everyRow' : 'unheldRow', message: refusal.message };
  }

  /** mEdit could not be reached or read. Never downgrades a second window's refusal. */
  unreachable(reason: string): void {
    if (this.expansionOverride?.scope !== 'everyRow') this.expansionOverride = { scope: 'unheldRow', message: reason };
  }

  private clearOverride(): void {
    this.expansionOverride = undefined;
    this.indexFailure = undefined;
  }

  /** The completed reconcile's hand-off: which plugins mEdit holds, their facts, and each
   *  failure. */
  reconciled(plugins: readonly PluginMetadata[], failures: readonly PluginLoadFailure[]): void {
    this.held = heldSet(plugins);
    this.loadFailures = indexLoadFailures(failures);
    this.reachableFailures = this.loadFailures;
    this.clearOverride();
    this.refreshed(plugins);
  }

  /** The facts alone, leaving which plugins are held as they are. No `missingMasters` means not
   *  yet checked, so the last answer stays until one lands. */
  refreshed(plugins: readonly PluginMetadata[]): void {
    answered(this.factsRead);
    const reads = new ByPluginAddress<PluginRead>();
    const matches = new ByPluginAddress<boolean>();
    for (const p of plugins) {
      reads.set(p, {
        readOnly: !pluginCanBeEdited(p), compiledPlugin: p.isCompiledPlugin,
        sourceUnreadable: p.pluginSourceUnreadable ?? undefined, parseFailure: p.hasParseFailure,
        masters: p.masters, missingMasters: p.missingMasters ?? this.reads.get(p)?.missingMasters,
        lateMasters: p.lateMasters ?? this.reads.get(p)?.lateMasters,
      });
      matches.set(p, p.hasMatchingRecords);
    }
    this.reads = reads;
    this.matches = matches;
    this.laterFailures = new Map(plugins.flatMap((p) => p.laterReadFailure == null ? [] : [[
      pluginAddressKey(p),
      `"${p.name}" (${p.origin}): ${p.laterReadFailure.map((f) => `${f.sourceRelativePath}: ${f.message}`).join('; ')}`,
    ] as const]));
    this.noMatchAnywhere = plugins.length > 0 && plugins.every((p) => !p.hasMatchingRecords);
  }

  /** mEdit's facts about each plugin could not be read: a row not held expands to the error row
   *  naming why, and the last answer stays. */
  factsFailed(reason: string): void {
    this.unreachable(reason);
    this.factsRead.failure = reason;
  }

  /** The malformed-plugin scan's answer, replacing the last. */
  diagnosed(reports: readonly PluginDiagnosisReport[]): void {
    answered(this.scanRead);
    this.diagnosisReports = [...reports];
    this.diagnosisTexts = new ByPluginAddress<string[]>();
    for (const r of reports) this.diagnosisTexts.append({ name: r.plugin, origin: r.origin }, r.text);
  }

  /** The malformed-plugin scan could not be read; the last answer stays. */
  scanFailed(reason: string): void {
    this.scanRead.failure = reason;
  }

  /** Each settle of a source mod names every plugin of it that changed outside Modbench, so it
   *  replaces what the mod's last settle named. */
  externalChange(event: NotificationPayloads['external-change']): void {
    this.changedByMod.set(event.origin, event.changedPlugins.map(({ name }) => ({ name, origin: event.origin })));
    this.changed = new ByPluginAddress<true>();
    for (const address of [...this.changedByMod.values()].flat()) this.changed.set(address, true);
  }

  /** Each plugin a mod's manifest names that is not restored, with that mod, replacing the last. */
  notRestored(plugins: readonly { readonly plugin: PluginAddress; readonly mod: string }[]): void {
    this.notRestoredFrom = new ByPluginAddress<string>();
    for (const { plugin, mod } of plugins) this.notRestoredFrom.set(plugin, mod);
  }

  /** The record filter changed, so the last answer belongs to another filter. */
  forgetMatches(): void {
    this.matches = undefined;
  }

  private isHeld(address: PluginAddress): boolean {
    return this.held.has(address);
  }

  /** What expanding the plugin's row shows, in precedence order (plugins.md, States, stories 2-4
   *  and 6). */
  expansion(address: PluginAddress): Expansion {
    if (this.expansionOverride?.scope === 'everyRow') return { kind: 'error', message: this.expansionOverride.message };
    if (this.isHeld(address)) return { kind: 'records' };
    const failure = this.reachableFailures.get(address)?.reason;
    if (failure !== undefined) return { kind: 'error', message: failure };
    if (this.expansionOverride !== undefined) return { kind: 'error', message: this.expansionOverride.message };
    return { kind: 'indexing' };
  }

  /** The message line's part for every read that failed, the instance's own among them
   *  (common.md, States, stories 2 and 6). */
  readFailureMessage(instanceReadFailure?: string): string | undefined {
    const failed = [this.factsRead, this.scanRead].filter((read) => read.failure !== undefined);
    const said = (read: FactsRead) => `${read.what}: ${read.failure}`;
    const lastGood = [instanceReadFailure, ...this.laterFailures.values(), ...failed.filter((read) => read.answered).map(said)]
      .filter((reason) => reason !== undefined);
    const neverAnswered = failed.filter((read) => !read.answered).map(said);
    const lines = [
      lastGood.length === 0 ? undefined : `Showing the last good read: ${lastGood.join('; ')}`,
      neverAnswered.length === 0 ? undefined : `Failed to load: ${neverAnswered.join('; ')}`,
    ].filter((line) => line !== undefined);
    return lines.length === 0 ? undefined : lines.join(' ');
  }

  /** The failed index (plugins.md, States 6). */
  indexFailureMessage(): string | undefined {
    return this.indexFailure === undefined ? undefined : `Indexing failed: ${this.indexFailure}`;
  }

  /** A record filter matching nothing (common.md, States 5). */
  noRecordMatchMessage(recordFilterSource: string): string | undefined {
    return this.matches !== undefined && this.noMatchAnywhere ? `No records match ${recordFilterSource}.` : undefined;
  }

  /** Whether a record filter in force leaves the plugin with nothing; false while mEdit has not
   *  answered. `hasMatchingRecords` only ever answers false while a filter is active. */
  hiddenByRecordFilter(address: PluginAddress): boolean {
    return this.matches?.get(address) === false;
  }

  private statuses(address: PluginAddress): PluginStatus[] {
    const read = this.reads.get(address);
    return [
      notRestored(this.notRestoredFrom.get(address)),
      failedToRead(this.loadFailures.get(address)?.reason),
      masterIssues(read?.missingMasters ?? [], read?.lateMasters ?? []),
      unreadableRecords(read?.parseFailure === true),
      sourceUnreadable(read?.sourceUnreadable),
      changedOutside(this.changed.has(address)),
      malformed(this.diagnosisTexts.get(address) ?? []),
    ].filter((s): s is PluginStatus => s !== undefined);
  }

  /** The file names of the plugin's masters; none until mEdit has read it. */
  mastersOf(address: PluginAddress): readonly string[] {
    return this.reads.get(address)?.masters ?? [];
  }

  /** The red or yellow icon of the first status; none when the plugin has none. */
  icon(address: PluginAddress): StatusIcon | undefined {
    const [first] = this.statuses(address);
    if (first === undefined) return undefined;
    return WARNING_KINDS.has(first.kind) ? 'warning' : 'error';
  }

  /** The status words, left out when the plugin has none. */
  description(address: PluginAddress): string | undefined {
    const statuses = this.statuses(address);
    return statuses.length === 0 ? undefined : statuses.map((s) => s.words).join(', ');
  }

  /** The tooltip: file name, origin, read-only when its records cannot be edited, and a line for
   *  each status. A plugin not restored has the mod whose manifest names it as its origin (ADR-0012). */
  tooltipLines(address: PluginAddress): string[] {
    const lines = [address.name, this.notRestoredFrom.get(address) ?? pluginOriginName(address.origin)];
    if (this.reads.get(address)?.readOnly === true) lines.push('read-only');
    return [...lines, ...this.statuses(address).map((s) => s.tooltipLine)];
  }

  /** Nothing until mEdit answers: an unknown is neither a compiled plugin nor one with no plugin source, nor editable. */
  contextFlags(address: PluginAddress): string[] {
    const read = this.reads.get(address);
    const flags: string[] = [];
    if (read !== undefined) flags.push(read.compiledPlugin ? 'compiledPlugin' : 'nonCompiledPlugin');
    if (read?.readOnly === false) flags.push('editable');
    if (this.diagnosisTexts.get(address) !== undefined) flags.push('malformed');
    return flags;
  }

  conditions(address: PluginAddress): PluginConditions {
    const read = this.reads.get(address);
    return { editable: read?.readOnly === false };
  }

  /** What the Problems panel shows, read from the same answers as the rows' statuses. */
  problems(): { malformed: PluginDiagnosisReport[]; changedOutside: readonly PluginProblem[]; failedToRead: readonly PluginProblem[] } {
    return {
      malformed: this.diagnosisReports,
      failedToRead: this.loadFailures.values().flatMap(({ name, origin, diagnosis }) =>
        diagnosis == null ? [] : [{ plugin: name, origin, text: diagnosis }]),
      changedOutside: [...this.changedByMod.values()].flat()
        .map(({ name, origin }) => ({ plugin: name, origin, text: CHANGED_OUTSIDE_TEXT })),
    };
  }
}

function answered(read: FactsRead): void {
  read.failure = undefined;
  read.answered = true;
}

function heldSet(plugins: readonly PluginAddress[]): ByPluginAddress<true> {
  const held = new ByPluginAddress<true>();
  for (const plugin of plugins) held.set(plugin, true);
  return held;
}

function indexLoadFailures(
  failures: readonly PluginLoadFailure[], byAddress = new ByPluginAddress<PluginLoadFailure>(),
): ByPluginAddress<PluginLoadFailure> {
  for (const f of failures) byAddress.set(f, f);
  return byAddress;
}
