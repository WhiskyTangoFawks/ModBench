import type { LoadOrderRefusal, NotificationPayloads, PluginAddress, PluginDiagnosisReport, PluginLoadFailure, PluginMetadata } from '../client';
import { OVERWRITE_ORIGIN } from '../instanceLoader/loadOrderSnapshot';
import { modOfOrigin } from '../instanceLoader/modOfOrigin';
import { ByPluginAddress } from './pluginAddress';

/** A warning on one plugin's file, as the Problems panel shows it. */
export type PluginWarning = Pick<PluginDiagnosisReport, 'plugin' | 'origin' | 'text'>;

type StatusKind = 'failedToRead' | 'masterIssues' | 'unreadableRecords' | 'sourceUnreadable' | 'changedOutside' | 'malformed';

export interface PluginStatus {
  kind: StatusKind;
  words: string;
  tooltipLine: string;
}

export type StatusIcon = 'error' | 'warning';

export type PluginPlace = 'inTrackedMod' | 'inUntrackedMod' | 'inOverwrite';

export interface PluginConditions {
  readonly tracked: boolean;
  readonly editable: boolean;
}

/** The instance value's two facts about where a mod's plugins live. */
export interface PlaceFacts {
  readonly modDirs: ReadonlyMap<string, string>;
  readonly trackedMods: ReadonlySet<string>;
}

/** What a plugin row expands into: its records, the error row naming why not, or the still-indexing row. */
export type Expansion = { kind: 'records' } | { kind: 'error'; message: string } | { kind: 'indexing' };

// `everyRow`: another window holds the instance (ADR-0010). `unheldRow`: mEdit unreachable, or the
// snapshot's index failed.
type ExpansionOverride = { scope: 'everyRow' | 'unheldRow'; message: string };

const WARNING_KINDS: ReadonlySet<StatusKind> = new Set(['sourceUnreadable', 'changedOutside', 'malformed']);

const CHANGED_OUTSIDE_TEXT = 'Changed outside Modbench: its bytes differ from what Modbench last wrote.';

interface PluginRead {
  readOnly: boolean;
  tracked: boolean;
  sourceUnreadable: boolean;
  masterIssues?: string[];
  parseFailure: boolean;
}

// plugins.md, A row, Plugin: each status's words and tooltip line.
const failedToRead = (reason: string | undefined): PluginStatus | undefined => reason === undefined ? undefined
  : { kind: 'failedToRead', words: 'failed to read', tooltipLine: `Failed to read: ${reason}` };

// "Missing" is the reference tool's word for a master that is not active, file present or not.
const masterIssues = (inactiveMasters: readonly string[]): PluginStatus | undefined => inactiveMasters.length === 0 ? undefined
  : {
    kind: 'masterIssues',
    words: inactiveMasters.length === 1 ? '1 master issue' : `${inactiveMasters.length} master issues`,
    tooltipLine: `Missing masters: ${inactiveMasters.join(', ')}`,
  };

const unreadableRecords = (held: boolean): PluginStatus | undefined => !held ? undefined
  : {
    kind: 'unreadableRecords', words: 'unreadable records',
    tooltipLine: 'This plugin holds a record that could not be read into its document.',
  };

const sourceUnreadable = (unreadable: boolean): PluginStatus | undefined => !unreadable ? undefined
  : {
    kind: 'sourceUnreadable', words: 'plugin source unreadable',
    tooltipLine: 'Plugin source unreadable: its records are those of its plugin file, until decompile writes its source.',
  };

const changedOutside = (changed: boolean): PluginStatus | undefined => !changed ? undefined
  : { kind: 'changedOutside', words: 'changed outside Modbench', tooltipLine: CHANGED_OUTSIDE_TEXT };

const malformed = (diagnosisTexts: readonly string[]): PluginStatus | undefined => diagnosisTexts.length === 0 ? undefined
  : { kind: 'malformed', words: 'malformed', tooltipLine: `Malformed: ${diagnosisTexts.join('; ')}` };

// The instance value names each mod's folder, whatever the mod manager calls the others, and
// each mod whose folder holds a repository.
export function placeOf(origin: string, { modDirs, trackedMods }: PlaceFacts): PluginPlace | undefined {
  if (origin === OVERWRITE_ORIGIN) return 'inOverwrite';
  const mod = modOfOrigin(modDirs, origin);
  if (mod === undefined) return undefined;
  return trackedMods.has(mod) ? 'inTrackedMod' : 'inUntrackedMod';
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
  // Row status only, no blink: merges across a reload's ticks and persists until `reconciled`
  // lands the new answer.
  private loadFailures = new ByPluginAddress<string>();
  // Children expansion only: this reload's own ticks, replaced wholesale each time, so a plugin
  // not yet reached reads as still indexing, never a stale failure from before the reload began.
  private reachableFailures = new ByPluginAddress<string>();
  private expansionOverride?: ExpansionOverride;
  private indexFailure?: string;
  private compilable = false;
  private noMatchAnywhere = false;

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

  /** The facts alone, leaving which plugins are held as they are. */
  refreshed(plugins: readonly PluginMetadata[]): void {
    const reads = new ByPluginAddress<PluginRead>();
    const matches = new ByPluginAddress<boolean>();
    for (const p of plugins) {
      reads.set(p, {
        readOnly: p.isImmutable || p.pluginSourceUnreadable, tracked: p.isTracked,
        sourceUnreadable: p.pluginSourceUnreadable, parseFailure: p.hasParseFailure,
        masterIssues: p.masterIssues,
      });
      matches.set(p, p.hasMatchingRecords);
    }
    this.reads = reads;
    this.matches = matches;
    this.compilable = plugins.some((p) => p.isTracked);
    this.noMatchAnywhere = plugins.length > 0 && plugins.every((p) => !p.hasMatchingRecords);
  }

  /** The malformed-plugin scan's answer, replacing the last. */
  diagnosed(reports: readonly PluginDiagnosisReport[]): void {
    this.diagnosisReports = [...reports];
    this.diagnosisTexts = new ByPluginAddress<string[]>();
    for (const r of reports) this.diagnosisTexts.append({ name: r.plugin, origin: r.origin }, r.text);
  }

  /** Each settle of a tracked mod names every plugin of it that changed outside Modbench, so it
   *  replaces what the mod's last settle named. */
  externalChange(event: NotificationPayloads['external-change']): void {
    this.changedByMod.set(event.origin, event.changedPlugins.map(({ name }) => ({ name, origin: event.origin })));
    this.changed = new ByPluginAddress<true>();
    for (const address of [...this.changedByMod.values()].flat()) this.changed.set(address, true);
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
    const failure = this.reachableFailures.get(address);
    if (failure !== undefined) return { kind: 'error', message: failure };
    if (this.expansionOverride !== undefined) return { kind: 'error', message: this.expansionOverride.message };
    return { kind: 'indexing' };
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

  /** Whether compile applies to any plugin. */
  anyCompilable(): boolean {
    return this.compilable;
  }

  private statuses(address: PluginAddress): PluginStatus[] {
    const read = this.reads.get(address);
    return [
      failedToRead(this.loadFailures.get(address)),
      masterIssues(read?.masterIssues ?? []),
      unreadableRecords(read?.parseFailure === true),
      sourceUnreadable(read?.sourceUnreadable === true),
      changedOutside(this.changed.has(address)),
      malformed(this.diagnosisTexts.get(address) ?? []),
    ].filter((s): s is PluginStatus => s !== undefined);
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
   *  each status. */
  tooltipLines(address: PluginAddress): string[] {
    const lines = [address.name, address.origin];
    if (this.reads.get(address)?.readOnly === true) lines.push('read-only');
    return [...lines, ...this.statuses(address).map((s) => s.tooltipLine)];
  }

  /** Nothing until mEdit answers: an unknown is neither tracked nor untracked, nor editable. */
  contextFlags(address: PluginAddress): string[] {
    const read = this.reads.get(address);
    const flags: string[] = [];
    if (read !== undefined) flags.push(read.tracked ? 'tracked' : 'untracked');
    if (read?.readOnly === false) flags.push('editable');
    return flags;
  }

  conditions(address: PluginAddress): PluginConditions {
    const read = this.reads.get(address);
    return { tracked: read?.tracked === true, editable: read?.readOnly === false };
  }

  /** What the Problems panel shows, read from the same answers as the rows' statuses. */
  problems(): { malformed: PluginDiagnosisReport[]; changedOutside: readonly PluginWarning[] } {
    return {
      malformed: this.diagnosisReports,
      changedOutside: [...this.changedByMod.values()].flat()
        .map(({ name, origin }) => ({ plugin: name, origin, text: CHANGED_OUTSIDE_TEXT })),
    };
  }
}

function heldSet(plugins: readonly PluginAddress[]): ByPluginAddress<true> {
  const held = new ByPluginAddress<true>();
  for (const plugin of plugins) held.set(plugin, true);
  return held;
}

function indexLoadFailures(failures: readonly PluginLoadFailure[], byAddress = new ByPluginAddress<string>()): ByPluginAddress<string> {
  for (const f of failures) byAddress.set(f, f.reason);
  return byAddress;
}
