import * as vscode from 'vscode';
import type { LoadOrderRefusal, MEditClient, PluginAddress, PluginDiagnosisReport, PluginLoadFailure, PluginMetadata } from '../client';
import { errorMessage } from '../ports/errorMessage';
import { pluginAddressKey } from '../wire/pluginAddress';
import { PluginFacts, type PluginProblem, type SourceUnreadableProblem } from './pluginFacts';
import { ruleFileDiagnostics, type RuleFileDiagnostic } from '../sortingRules/ruleFileDiagnostics';
import type { LootRules } from '../sortingRules/lootJudge';
import type { ReadRules } from '../sortingRules/lootMetadata';
import { answerOf, ReadFailedError } from '../wire/readFailed';

/** The mEdit reads every plugin-keyed fact comes from, and the notification that names a plugin
 *  changed outside Modbench. */
export type PluginFactsClient = Pick<MEditClient, 'getPlugins' | 'getDiagnoses' | 'onNotification'>;

export interface PluginFactsFeedDeps {
  client: PluginFactsClient;
  /** The plugins the tree shows; mEdit's facts about any other are dropped. */
  shownPlugins: () => readonly PluginAddress[];
  /** The plugins the game loads, in load order: the order the sorting rules judge. */
  activePlugins: () => readonly PluginAddress[];
  /** Every plugins.txt line, enabled or not, in load order: the order a move is written into. */
  lines: () => readonly PluginAddress[];
  /** LOOT's rules from the instance's sorting rule files, and the files they came from. */
  rules: () => LootRules & Pick<ReadRules, 'files' | 'problems'>;
  /** The malformed-plugin scan's other surface, the Problems panel. */
  publishDiagnoses: (reports: PluginDiagnosisReport[]) => void;
  /** The Changed outside Modbench status's other surface, the Problems panel. */
  publishChangedOutside: (warnings: readonly PluginProblem[]) => void;
  /** A failed read's diagnosis, the defect in the plugin's bytes that stopped it: an error in the Problems panel. */
  publishFailedToRead: (errors: readonly PluginProblem[]) => void;
  /** The Plugin source unreadable status's other surface, the Problems panel. */
  publishSourceUnreadable: (warnings: readonly SourceUnreadableProblem[]) => void;
  /** The Sorting errors status's other surface, the Problems panel. */
  publishSortingErrors: (errors: readonly PluginProblem[]) => void;
  /** The Sorting warnings status's other surface, the Problems panel. */
  publishSortingWarnings: (warnings: readonly PluginProblem[]) => void;
  /** The Info sorting rules' only surface besides the tooltip, the Problems panel. */
  publishSortingInfo: (info: readonly PluginProblem[]) => void;
  /** The sorting rule files' own lines in the Problems panel. */
  publishRuleFiles: (diagnostics: readonly RuleFileDiagnostic[]) => void;
}

export type PluginRowFacts = Pick<PluginFacts,
  'expansion' | 'indexFailureMessage' | 'heldElsewhereMessage' | 'readFailureMessage' | 'noRecordMatchMessage' | 'hiddenByRecordFilter'
  | 'mastersOf' | 'shown' | 'icon' | 'description' | 'tooltipLines' | 'contextFlags' | 'conditions' | 'suggestedMoves' | 'suggestedMovesOf'>;

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

  /** Each row a mod's manifest names that is not restored, joined by the tree, which fires its own change. */
  notRestored(plugins: Parameters<PluginFacts['notRestored']>[0]): void {
    this.facts.notRestored(plugins);
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
    if (generation !== this.generation) return undefined;
    if ('failure' in plugins) return this.factsFailed(plugins.failure);
    this.facts.reconciled(plugins, failures, this.deps.activePlugins(), this.deps.lines(), this.deps.rules());
    this.deps.publishFailedToRead(this.facts.problems().failedToRead);
    this.publishSorting();
    this.deps.publishSourceUnreadable(this.facts.problems().sourceUnreadable);
    // Diagnoses stay as the last scan left them (no blink) until the scan lands a fresh answer.
    this.changed.fire();
    // Fire-and-forget: the hand-off must not wait on a whole-load-order scan. A failed scan is
    // ADR-0019's background tier, and retries at the next reconcile.
    void this.scanDiagnoses(generation);
    return plugins.length;
  }

  private publishSorting(): void {
    const { sortingErrors, sortingWarnings, sortingInfo } = this.facts.problems();
    this.deps.publishSortingErrors(sortingErrors);
    this.deps.publishSortingWarnings(sortingWarnings);
    this.deps.publishSortingInfo(sortingInfo);
    const { files, problems } = this.deps.rules();
    this.deps.publishRuleFiles(ruleFileDiagnostics(files, problems, this.facts.brokenRules()));
  }

  /** LOOT's rules changed: the order the last reconcile judged is judged again. Before that reconcile there is nothing to judge. */
  rulesChanged(): void {
    if (!this.facts.rejudged(this.deps.rules())) return;
    this.publishSorting();
    this.changed.fire();
  }

  /** Re-reads the facts alone, leaving the held load order as it is. A later re-read wins, and
   *  none supersedes a reconcile's hand-off. */
  async refresh(): Promise<void> {
    const generation = this.generation;
    const refresh = ++this.refreshes;
    const plugins = await this.readPlugins();
    if (generation !== this.generation || refresh !== this.refreshes) return;
    if ('failure' in plugins) return this.factsFailed(plugins.failure);
    this.facts.refreshed(plugins);
    this.deps.publishSourceUnreadable(this.facts.problems().sourceUnreadable);
    this.changed.fire();
  }

  /** The record filter changed, so the last answer belongs to another filter. */
  forgetMatches(): void {
    this.facts.forgetMatches();
  }

  // The plugins of the rows the tree shows, joined by (origin, filename). A failed read is never
  // swallowed into an empty list, which would read as "nothing held".
  private async readPlugins(): Promise<PluginMetadata[] | { failure: string }> {
    try {
      const shown = new Set(this.deps.shownPlugins().map(pluginAddressKey));
      return answerOf(await this.deps.client.getPlugins()).filter((p) => shown.has(pluginAddressKey(p)));
    } catch (err) {
      if (!(err instanceof ReadFailedError)) throw err;
      return { failure: errorMessage(err) };
    }
  }

  private factsFailed(reason: string): undefined {
    this.facts.factsFailed(reason);
    this.changed.fire();
    return undefined;
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
      if (!(err instanceof ReadFailedError)) throw err;
      const reason = errorMessage(err);
      if (generation !== this.generation) return;
      this.facts.scanFailed(reason);
      this.changed.fire();
    }
  }
}
