import * as vscode from 'vscode';
import type { LoadOrderRefusal, MEditClient, PluginAddress, PluginDiagnosisReport, PluginLoadFailure, PluginMetadata } from '../client';
import { errorMessage } from '../ports/errorMessage';
import { exactPluginAddressKey, samePluginAddress } from '../wire/pluginAddress';
import type { NamedPlugins } from './pluginAddress';
import { PluginFacts, type LootInput, type PluginProblem, type SourceUnreadableProblem } from './pluginFacts';
import { ruleFileDiagnostics, type RuleFileDiagnostic } from '../sortingRules/ruleFileDiagnostics';
import type { FileFacts, FileRead } from '../sortingRules/lootConditions';
import { readsNamed } from '../sortingRules/lootJudge';
import type { ReadRules } from '../sortingRules/lootMetadata';
import { answerOf, isReadFailed, ReadFailedError } from '../wire/readFailed';

/** The mEdit reads every plugin-keyed fact comes from. */
export type PluginFactsClient = Pick<MEditClient, 'getPlugins' | 'getDiagnoses' | 'getPluginsIndexing' | 'recordIndexProgress'>;

export interface PluginFactsFeedDeps {
  client: PluginFactsClient;
  /** The plugins the tree shows; mEdit's facts about any other are dropped. */
  shownPlugins: () => readonly PluginAddress[];
  /** The plugins the game loads, as the view lists them: the sorting rules judge the order the game loads them in. */
  activePlugins: () => readonly PluginAddress[];
  /** Every plugins.txt line, enabled or not, in load order: the order a move is written into. */
  lines: () => readonly PluginAddress[];
  /** LOOT's rules from the instance's sorting rule files, and the files they came from. */
  rules: () => ReadRules;
  /** What the instance says of the files the reads name: the Data folder, and the Instance adapter's reads. */
  fileFacts: (reads: readonly FileRead[]) => Promise<FileFacts>;
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
  | 'mastersOf' | 'isBlueprint' | 'blueprintPlugins' | 'shown' | 'icon' | 'description' | 'tooltipLines' | 'contextFlags' | 'conditions' | 'suggestedMoves' | 'suggestedMovesOf' | 'brokenRules' | 'sortingNotJudged'>;

/** mEdit's answers about each plugin, ordered into the facts the Plugins tree's rows read: the
 *  reconcile narrator's events go in; row queries and one change event come out. Pulled once per
 *  event, never per rendered row. */
export class PluginFactsFeed implements vscode.Disposable {
  private readonly facts = new PluginFacts();
  private readonly changed = new vscode.EventEmitter<NamedPlugins>();
  // Bumped by each reconcile step (a tick, a refusal, unreachable, the hand-off), so a slow read
  // answering after a newer step cannot resurrect a stale answer.
  private generation = 0;
  // Each `refresh` reads after the one before it answered, so an answer for a plugin never lands over a newer one.
  private refreshing: Promise<unknown> = Promise.resolve();
  // The order of `rejudge`, so only the newest judgement of an order publishes.
  private rejudgements = 0;

  readonly rows: PluginRowFacts = this.facts;
  readonly onDidChange = this.changed.event;

  constructor(private readonly deps: PluginFactsFeedDeps) {}

  dispose(): void {
    this.changed.dispose();
  }

  /** A progressive reconcile's tick. Row status stays as the last reconcile left it until
   *  `reconciled` lands; expansion tracks only this reload's own ticks. */
  indexed(plugins: readonly PluginAddress[], failures: readonly PluginLoadFailure[]): void {
    this.generation++;
    this.facts.indexed(plugins, failures);
    this.changed.fire(undefined);
  }

  /** Each row a mod's manifest names that is not restored, joined by the tree, which fires its own change. */
  notRestored(plugins: Parameters<PluginFacts['notRestored']>[0]): void {
    this.facts.notRestored(plugins);
  }

  /** The load order's own refusal (ADR-0010; plugins.md, States, stories 4 and 6). */
  refused(refusal: LoadOrderRefusal): void {
    this.generation++;
    this.facts.refused(refusal);
    this.changed.fire(undefined);
  }

  /** mEdit confirmed unreachable (ADR-0002; plugins.md, States, story 3). */
  unreachable(reason: string): void {
    this.generation++;
    this.facts.unreachable(reason);
    this.changed.fire(undefined);
  }

  /** The completed reconcile's whole hand-off, in one read: which files the backend holds, and
   *  every fact it answers about each plugin. Returns how many plugins it holds; `undefined` when
   *  the read failed or a newer step superseded it. */
  async reconciled(failures: readonly PluginLoadFailure[]): Promise<{ held: number; active: number; rowsGone: PluginLoadFailure[] } | undefined> {
    const generation = ++this.generation;
    const plugins = await this.readPlugins(undefined);
    if (generation !== this.generation) return undefined;
    if ('failure' in plugins) return this.factsFailed(plugins.failure);
    const active = this.deps.activePlugins();
    const loot = await this.lootRules(active);
    if (generation !== this.generation) return undefined;
    const rowsGone = this.facts.reconciled(plugins, failures, active, this.deps.lines(), loot);
    this.deps.publishFailedToRead(this.facts.problems().failedToRead);
    this.publishSorting();
    this.deps.publishSourceUnreadable(this.facts.problems().sourceUnreadable);
    await this.readChangedOutside();
    if (generation !== this.generation) return undefined;
    // Diagnoses stay as the last scan left them (no blink) until the scan lands a fresh answer.
    this.changed.fire(undefined);
    // Fire-and-forget: the hand-off must not wait on a whole-load-order scan. A failed scan is
    // ADR-0019's background tier, and retries at the next reconcile.
    void this.scanDiagnoses(generation);
    return { held: plugins.length, active: active.length, rowsGone };
  }

  private async readChangedOutside(): Promise<void> {
    const indexing = await this.deps.client.getPluginsIndexing();
    if (!isReadFailed(indexing)) this.facts.changedOutsideAre(indexing.filter(({ changedOutside }) => changedOutside).map(({ name, origin }) => ({ name, origin })));
    this.deps.publishChangedOutside(this.facts.problems().changedOutside);
  }

  private publishSorting(): void {
    const { sortingErrors, sortingWarnings, sortingInfo } = this.facts.problems();
    this.deps.publishSortingErrors(sortingErrors);
    this.deps.publishSortingWarnings(sortingWarnings);
    this.deps.publishSortingInfo(sortingInfo);
    const { files, problems } = this.deps.rules();
    this.deps.publishRuleFiles(ruleFileDiagnostics(files, problems, this.facts.brokenRules()));
  }

  // Read again while the rules change under the reads, so a judgement never holds rules other than the ones standing.
  private async lootRules(active: readonly PluginAddress[]): Promise<LootInput> {
    for (;;) {
      const read = this.deps.rules();
      const files = await this.deps.fileFacts(readsNamed(active.map(({ name, origin }) => ({ origin, filename: name })), read.entries));
      if (read === this.deps.rules()) return { entries: read.entries, groups: read.groups, files };
    }
  }

  /** Judges the order the last reconcile judged again. Before that reconcile there is nothing to judge. */
  async rejudge(): Promise<void> {
    await this.rejudgeAnnouncing([]);
  }

  private async rejudgeAnnouncing(announced: NamedPlugins): Promise<void> {
    const judged = this.facts.judgedOrder();
    if (judged === undefined) return;
    const rejudgement = ++this.rejudgements;
    const loot = await this.lootRules(judged);
    if (rejudgement !== this.rejudgements || judged !== this.facts.judgedOrder()) return;
    const altered = this.facts.rejudged(loot);
    this.publishSorting();
    this.changed.fire(announced && [...announced, ...altered.filter((plugin) => !announced.some((a) => samePluginAddress(a, plugin)))]);
  }

  /** Re-reads the facts of the plugins named and judges again, leaving the held load order as it is.
   *  After a failed read it reads every plugin, as any may be stale. Never supersedes a hand-off. */
  refresh(named?: NamedPlugins): Promise<void> {
    const generation = this.generation;
    const refreshed = this.refreshing.then(() => this.refreshOnce(named, generation));
    this.refreshing = refreshed.catch(() => undefined);
    return refreshed;
  }

  private async refreshOnce(requested: NamedPlugins, generation: number): Promise<void> {
    // mEdit answers no plugin's facts while it holds no load order: before the first put, and from a restart to the next.
    if (requested?.length === 0 || this.deps.client.recordIndexProgress === undefined) return;
    const named = this.facts.factsReadFailed() ? undefined : requested;
    const plugins = await this.readPlugins(named);
    if (generation !== this.generation) return;
    if ('failure' in plugins) return this.factsFailed(plugins.failure);
    const sortingChanged = this.facts.refreshed(plugins, named);
    this.deps.publishSourceUnreadable(this.facts.problems().sourceUnreadable);
    await this.readChangedOutside();
    if (generation !== this.generation) return;
    if (this.facts.judgedOrder() !== undefined && sortingChanged) await this.rejudgeAnnouncing(named);
    else this.changed.fire(named);
  }

  /** Settles once every refresh asked so far has. */
  settled(): Promise<unknown> {
    return this.refreshing;
  }

  /** The record filter changed, so the last answer belongs to another filter. */
  forgetMatches(): void {
    this.facts.forgetMatches();
  }

  // The plugins of the rows the tree shows, joined by (origin, filename). A failed read is never
  // swallowed into an empty list, which would read as "nothing held".
  private async readPlugins(named: NamedPlugins): Promise<PluginMetadata[] | { failure: string }> {
    try {
      const shown = new Set(this.deps.shownPlugins().map(exactPluginAddressKey));
      return answerOf(await this.deps.client.getPlugins(named)).filter((p) => shown.has(exactPluginAddressKey(p)));
    } catch (err) {
      if (!(err instanceof ReadFailedError)) throw err;
      return { failure: errorMessage(err) };
    }
  }

  private factsFailed(reason: string): undefined {
    this.facts.factsFailed(reason);
    this.changed.fire(undefined);
    return undefined;
  }

  private async scanDiagnoses(generation: number): Promise<void> {
    try {
      const reports = answerOf(await this.deps.client.getDiagnoses());
      if (generation !== this.generation) return;
      // One derivation, two surfaces — the tree badge and the Problems panel cannot disagree.
      this.facts.diagnosed(reports);
      this.deps.publishDiagnoses(this.facts.problems().malformed);
      this.changed.fire(undefined);
    } catch (err) {
      if (!(err instanceof ReadFailedError)) throw err;
      const reason = errorMessage(err);
      if (generation !== this.generation) return;
      this.facts.scanFailed(reason);
      this.changed.fire(undefined);
    }
  }
}
