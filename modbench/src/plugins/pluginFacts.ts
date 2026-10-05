import type { NotificationPayloads, PluginAddress, PluginDiagnosisReport, PluginLoadFailure, PluginMetadata } from '../client';
import { OVERWRITE_ORIGIN } from '../instanceLoader/loadOrderSnapshot';
import type { PluginOrderFacts } from '../pluginsCommands/pluginOrder';
import { modOfOrigin } from './modOfOrigin';
import { ByPluginAddress } from './pluginAddress';

/** A warning on one plugin's file, as the Problems panel shows it. */
export type PluginWarning = Pick<PluginDiagnosisReport, 'plugin' | 'origin' | 'text'>;

export type StatusKind = 'failedToRead' | 'masterIssues' | 'unreadableRecords' | 'changedOutside' | 'malformed';

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

const CHANGED_OUTSIDE_TEXT = 'Changed outside Modbench: its bytes differ from what Modbench last wrote.';

interface PluginRead {
  readOnly: boolean;
  tracked: boolean;
  masterIssues?: string[];
  parseFailure: boolean;
  order: PluginOrderFacts;
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
  private compilable = false;
  private noMatchAnywhere = false;

  /** A progressive reconcile's tick. */
  indexed(plugins: readonly PluginAddress[], failures: readonly PluginLoadFailure[]): void {
    this.held = heldSet(plugins);
    this.reachableFailures = indexLoadFailures(failures);
    for (const f of failures) this.loadFailures.set(f.name, f.origin, f.reason);
  }

  /** The completed reconcile's hand-off: which plugins mEdit holds, their facts, and each
   *  failure. */
  reconciled(plugins: readonly PluginMetadata[], failures: readonly PluginLoadFailure[]): void {
    this.held = heldSet(plugins);
    this.loadFailures = indexLoadFailures(failures);
    this.reachableFailures = this.loadFailures;
    this.refreshed(plugins);
  }

  /** The facts alone, leaving which plugins are held as they are. No `masterIssues` means not
   *  yet checked, so the last answer stays until one lands. */
  refreshed(plugins: readonly PluginMetadata[]): void {
    const reads = new ByPluginAddress<PluginRead>();
    const matches = new ByPluginAddress<boolean>();
    for (const p of plugins) {
      reads.set(p.name, p.origin, {
        readOnly: p.isImmutable, tracked: p.isTracked, parseFailure: p.hasParseFailure,
        masterIssues: p.masterIssues ?? this.reads.get(p.name, p.origin)?.masterIssues,
        order: { masters: p.masters, blueprint: p.isBlueprint },
      });
      matches.set(p.name, p.origin, p.hasMatchingRecords);
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
    for (const r of reports) this.diagnosisTexts.append(r.plugin, r.origin, r.text);
  }

  /** Each settle of a tracked mod names every plugin of it that changed outside Modbench, so it
   *  replaces what the mod's last settle named. */
  externalChange(event: NotificationPayloads['external-change']): void {
    this.changedByMod.set(event.origin, event.changedPlugins.map(({ name }) => ({ name, origin: event.origin })));
    this.changed = new ByPluginAddress<true>();
    for (const { name, origin } of [...this.changedByMod.values()].flat()) this.changed.set(name, origin, true);
  }

  /** The read could not say which plugins match: show every row rather than freeze behind a
   *  stale answer. */
  matchesUnknown(): void {
    this.matches = undefined;
  }

  isHeld({ name, origin }: PluginAddress): boolean {
    return this.held.has(name, origin);
  }

  /** Why expanding the plugin will never index it, from this reload's own ticks. */
  reachableFailure({ name, origin }: PluginAddress): string | undefined {
    return this.reachableFailures.get(name, origin);
  }

  /** Whether a record filter in force leaves the plugin with nothing; false while mEdit has not
   *  answered. `hasMatchingRecords` only ever answers false while a filter is active. */
  hiddenByRecordFilter({ name, origin }: PluginAddress): boolean {
    return this.matches?.get(name, origin) === false;
  }

  recordFilterMatchesNothing(): boolean {
    return this.matches !== undefined && this.noMatchAnywhere;
  }

  /** Whether compile applies to any plugin. */
  anyCompilable(): boolean {
    return this.compilable;
  }

  /** Every status the plugin carries, in the spec's order: the first sets the icon. */
  statuses({ name, origin }: PluginAddress): PluginStatus[] {
    const read = this.reads.get(name, origin);
    return [
      failedToRead(this.loadFailures.get(name, origin)),
      masterIssues(read?.masterIssues ?? []),
      unreadableRecords(read?.parseFailure === true),
      changedOutside(this.changed.has(name, origin)),
      malformed(this.diagnosisTexts.get(name, origin) ?? []),
    ].filter((s): s is PluginStatus => s !== undefined);
  }

  /** The red or yellow icon of the first status; none when the plugin has none. A plugin changed
   *  outside Modbench or malformed still loads and plays, unlike the three red statuses. */
  icon(address: PluginAddress): StatusIcon | undefined {
    const [first] = this.statuses(address);
    if (first === undefined) return undefined;
    return first.kind === 'changedOutside' || first.kind === 'malformed' ? 'warning' : 'error';
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
    if (this.reads.get(address.name, address.origin)?.readOnly === true) lines.push('read-only');
    return [...lines, ...this.statuses(address).map((s) => s.tooltipLine)];
  }

  /** Nothing until mEdit answers: an unknown is neither tracked nor untracked, nor editable. */
  contextFlags({ name, origin }: PluginAddress): string[] {
    const read = this.reads.get(name, origin);
    const flags: string[] = [];
    if (read !== undefined) flags.push(read.tracked ? 'tracked' : 'untracked');
    if (read?.readOnly === false) flags.push('editable');
    return flags;
  }

  conditions({ name, origin }: PluginAddress): PluginConditions {
    const read = this.reads.get(name, origin);
    return { tracked: read?.tracked === true, editable: read?.readOnly === false };
  }

  orderFacts({ name, origin }: PluginAddress): PluginOrderFacts | undefined {
    return this.reads.get(name, origin)?.order;
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
  for (const { name, origin } of plugins) held.set(name, origin, true);
  return held;
}

function indexLoadFailures(failures: readonly PluginLoadFailure[]): ByPluginAddress<string> {
  const byAddress = new ByPluginAddress<string>();
  for (const f of failures) byAddress.set(f.name, f.origin, f.reason);
  return byAddress;
}
