import * as vscode from 'vscode';
import type { LoadOrderRefusal, MEditClient, PluginAddress, PluginDiagnosisReport, PluginLoadFailure, PluginMetadata } from '../client';
import { errorMessage } from '../ports/errorMessage';
import { pluginAddressKey } from '../wire/pluginAddress';
import { PluginFacts, type PluginWarning } from './pluginFacts';
import { answerOf } from '../wire/readFailed';

/** The mEdit reads every plugin-keyed fact comes from, and the notification that names a plugin
 *  changed outside Modbench. */
export type PluginFactsClient = Pick<MEditClient, 'getPlugins' | 'getDiagnoses' | 'onNotification'>;

export interface PluginFactsFeedDeps {
  client: PluginFactsClient;
  /** The plugins the tree shows; mEdit's facts about any other are dropped. */
  shownPlugins: () => readonly PluginAddress[];
  /** The malformed-plugin scan's other surface, the Problems panel. */
  publishDiagnoses: (reports: PluginDiagnosisReport[]) => void;
  /** The Changed outside Modbench status's other surface, the Problems panel. */
  publishChangedOutside: (warnings: readonly PluginWarning[]) => void;
  /** The feed states the severity (ADR-0019), so a background blip and a failed read land on
   *  different channel levels. */
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export type PluginRowFacts = Pick<PluginFacts,
  'expansion' | 'indexFailureMessage' | 'laterReadFailureMessage' | 'noRecordMatchMessage' | 'hiddenByRecordFilter' | 'anyCompilable'
  | 'icon' | 'description' | 'tooltipLines' | 'contextFlags' | 'conditions'>;

/** mEdit's answers about each plugin, ordered into the facts the Plugins tree's rows read: the
 *  reconcile narrator's events go in; row queries and one change event come out. Pulled once per
 *  event, never per rendered row. */
export class PluginFactsFeed implements vscode.Disposable {
  private readonly facts = new PluginFacts();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly unsubscribe: () => void;
  // Bumped by each reconcile step (a tick, a refusal, unreachable, the hand-off), so a slow read
  // answering after a newer step cannot resurrect a stale answer.
  private generation = 0;
  // `refresh`' own order, apart from `generation` so a fact re-read never discards a hand-off.
  private refreshes = 0;
  private failing = new Set<string>();

  readonly rows: PluginRowFacts = this.facts;
  readonly onDidChange = this.changed.event;

  constructor(private readonly deps: PluginFactsFeedDeps) {
    this.unsubscribe = deps.client.onNotification('external-change', (event) => {
      this.facts.externalChange(event);
      deps.publishChangedOutside(this.facts.problems().changedOutside);
      this.changed.fire();
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.changed.dispose();
  }

  /** A progressive reconcile's tick. Row status stays as the last reconcile left it until
   *  `reconciled` lands; expansion tracks only this reload's own ticks. */
  indexed(plugins: readonly PluginAddress[], failures: readonly PluginLoadFailure[]): void {
    this.generation++;
    this.facts.indexed(plugins, failures);
    this.changed.fire();
  }

  /** The load order's own refusal (ADR-0010; plugins.md, States, stories 4 and 6). */
  refused(refusal: LoadOrderRefusal): void {
    this.generation++;
    this.facts.refused(refusal);
    this.changed.fire();
  }

  /** mEdit confirmed unreachable (ADR-0002; plugins.md, States, story 3). */
  unreachable(reason: string): void {
    this.generation++;
    this.facts.unreachable(reason);
    this.changed.fire();
  }

  /** The completed reconcile's whole hand-off, in one read: which files the backend holds, and
   *  every fact it answers about each plugin. Returns how many plugins it holds; `undefined` when
   *  the read failed or a newer step superseded it. */
  async reconciled(failures: readonly PluginLoadFailure[]): Promise<number | undefined> {
    const generation = ++this.generation;
    const plugins = await this.readPlugins();
    if (plugins === undefined || generation !== this.generation) return undefined;
    this.facts.reconciled(plugins, failures);
    this.logBegunFailures();
    // Diagnoses stay as the last scan left them (no blink) until the scan lands a fresh answer;
    // a failed scan leaves them alone too.
    this.changed.fire();
    // Fire-and-forget: the hand-off must not wait on a whole-load-order scan. A failed scan is
    // ADR-0019's background tier, and retries at the next reconcile.
    void this.scanDiagnoses(generation);
    return plugins.length;
  }

  /** Re-reads the facts alone, leaving the held load order as it is. A later re-read wins, and
   *  none supersedes a reconcile's hand-off. */
  async refresh(): Promise<void> {
    const generation = this.generation;
    const refresh = ++this.refreshes;
    const plugins = await this.readPlugins();
    if (plugins === undefined || generation !== this.generation || refresh !== this.refreshes) return;
    this.facts.refreshed(plugins);
    this.logBegunFailures();
    this.changed.fire();
  }

  private logBegunFailures(): void {
    const standing = this.facts.laterReadFailures();
    for (const [key, words] of standing) {
      if (!this.failing.has(key)) this.deps.log('warn', `[PluginFactsFeed] showing the last good read of ${words}`);
    }
    this.failing = new Set(standing.keys());
  }

  /** The record filter changed, so the last answer belongs to another filter. */
  forgetMatches(): void {
    this.facts.forgetMatches();
  }

  // The plugins of the rows the tree shows, joined by (origin, filename). A failed read is never
  // swallowed into an empty list, which would read as "nothing held".
  private async readPlugins(): Promise<PluginMetadata[] | undefined> {
    try {
      const shown = new Set(this.deps.shownPlugins().map(pluginAddressKey));
      return answerOf(await this.deps.client.getPlugins()).filter((p) => shown.has(pluginAddressKey(p)));
    } catch (err) {
      const message = errorMessage(err);
      this.deps.log('error', `[PluginFactsFeed] reading the backend's plugin list failed: ${message}`);
      this.facts.unreachable(message);
      this.changed.fire();
      return undefined;
    }
  }

  private async scanDiagnoses(generation: number): Promise<void> {
    try {
      const reports = answerOf(await this.deps.client.getDiagnoses());
      if (generation !== this.generation) return;
      // One derivation, two surfaces — the tree badge and the Problems panel cannot disagree.
      this.facts.diagnosed(reports);
      this.deps.publishDiagnoses(this.facts.problems().malformed);
      this.changed.fire();
    } catch (err) {
      this.deps.log('warn', `[PluginFactsFeed] the malformed-plugin scan could not be read: ${errorMessage(err)}`);
    }
  }
}
