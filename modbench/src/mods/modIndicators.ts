// mods.md, Indicators: a badge and a colour on a mod's row for each status that holds.

import * as vscode from 'vscode';
import { DecorationRedrawEmitter } from '../drivingLib/heldRedraw';
import { MODS_KEY_ARGS } from './gestureEntry';
import type { InstanceValue, InstanceView, Mod, ModGroups } from '../instanceLoader/instance';
import { KeptCopyStanding, modOrigin, sameOrigin } from '../instanceLoader/fileConflictIndex';
import { copyPathsOf, indicatorsFrom, MOD_INDICATORS, type IndicatorsValue, type ModIndicator } from './modFileStates';
import { modEntryOf, RowsByOwner, rowsFollowing, touchedIn, type OriginsChange, type Owned, type Row } from './originsTouched';
import { TOUCHING_READ, type Touching } from '../instanceLoader/filesChanged';
import { onSettingChange } from '../drivingLib/setting';
import type { OpenRows } from './openRows';
import type { WorkspaceSettings } from './workspaceSettings';

/** The table's Publisher tag row: each publisher tag is an indicator of its own, with the badge its publisher declares,
 *  under one pair of settings and one colour.
 *  @public Read by packageJson.test, which holds package.json to it. */
export const PUBLISHER_TAG_INDICATOR = { id: 'publisherTag', colour: 'modbench.modPublisherTag' } as const;

type IndicatorId = ModIndicator | typeof PUBLISHER_TAG_INDICATOR.id;

// Not `file:`: a decoration on a `file:` URI shows on the mod's folder in the Explorer too.
const MOD_ROW_SCHEME = 'modbench-mod';
const SEPARATOR_ROW_SCHEME = 'modbench-separator';
const OVERWRITE_ROW_SCHEME = 'modbench-overwrite';

export const modRowUri = (name: string): vscode.Uri => vscode.Uri.from({ scheme: MOD_ROW_SCHEME, path: `/${name}` });

export const separatorRowUri = (name: string): vscode.Uri => vscode.Uri.from({ scheme: SEPARATOR_ROW_SCHEME, path: `/${name}` });

export const overwriteRowUri = (): vscode.Uri => vscode.Uri.from({ scheme: OVERWRITE_ROW_SCHEME, path: '/' });

/** @public Read by packageJson.test, which holds package.json to it. */
export const indicatorSetting = (id: IndicatorId, part: 'badge' | 'colour'): string => `modbench.mods.indicators.${id}.${part}`;

export const isModRow = (uri: vscode.Uri): boolean => uri.scheme === MOD_ROW_SCHEME;

interface Indicator {
  readonly id: IndicatorId;
  readonly name: string;
  readonly badge: string;
  readonly colour: string;
}

const PARTS = ['badge', 'colour'] as const;

/** One indicator's decoration on each row that carries it, its colour on the rows `coloured` takes. */
export class IndicatorDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new DecorationRedrawEmitter(MODS_KEY_ARGS.view);
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly indicator: Indicator,
    private readonly carried: (uri: vscode.Uri) => boolean,
    private readonly settings: WorkspaceSettings,
    private readonly coloured: (uri: vscode.Uri) => boolean = () => true,
  ) {
    this.subscription = onSettingChange(settings.onDidChangeConfiguration, PARTS.map((part) => indicatorSetting(indicator.id, part)), () => { this.refresh(); });
  }

  /** Asks VS Code again for the rows at `uris`, or for every row. */
  refresh(uris?: vscode.Uri[]): void {
    this.changed.fire(uris);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const { id, name, badge, colour } = this.indicator;
    if (!this.carried(uri)) return undefined;
    const configuration = this.settings.getConfiguration();
    const badgeOn = configuration.get(indicatorSetting(id, 'badge')) === true;
    const colourOn = configuration.get(indicatorSetting(id, 'colour')) === true && this.coloured(uri);
    if (!badgeOn && !colourOn) return undefined;
    return { badge: badgeOn ? badge : undefined, color: colourOn ? new vscode.ThemeColor(colour) : undefined, tooltip: name };
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

const rowsOf = <D>(...rows: readonly Row<D>[]): ReadonlyMap<string, Row<D>> => new Map(rows.map((row) => [row.uri.toString(), row]));

const separatorsHolding = new WeakMap<ModGroups, ReadonlyMap<string, string>>();

/** The separator each mod sits under, by the mod's name. */
export function separatorOf(groups: ModGroups, mod: string): string | undefined {
  let held = separatorsHolding.get(groups);
  if (held === undefined) {
    held = new Map(groups.groups.flatMap(({ separator, mods }) => mods.map(({ name }) => [name, separator.name] as const)));
    separatorsHolding.set(groups, held);
  }
  return held.get(mod);
}

/** VS Code never asks a decoration provider again on its own, so each fires for the rows a new instance value touches
 *  (ADR-0003), and for every row on a setting change or a row opened or closed. */
export abstract class OpenableRowDecorations<D, K extends keyof InstanceValue> implements vscode.Disposable {
  abstract readonly providers: readonly IndicatorDecorationProvider[];
  protected readonly rows: RowsByOwner<D>;
  private readonly held: () => RowsByOwner<D>;
  private readonly subscriptions: { dispose(): unknown }[];

  constructor(instance: Pick<InstanceView, 'value' | 'subscribe'>, private readonly openRows: OpenRows, concerns: Readonly<Record<K | keyof Touching, true>>, same: (a: D, b: D) => boolean) {
    this.rows = new RowsByOwner(same);
    const following = rowsFollowing(instance, concerns, this.rows, (value, change) => this.ownedAgain(value, change), (uris) => { this.refresh(uris); });
    this.held = following.held;
    this.subscriptions = [following.subscription, openRows.onDidChange(() => { this.refresh(); })];
  }

  /** The rows each owner a value touches gives: the origins first, then each separator that holds one, from the rows held. */
  protected abstract ownedAgain(value: Pick<InstanceValue, K | keyof Touching>, change: OriginsChange): Iterable<Owned<D>>;

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const provider of this.providers) provider.dispose();
  }

  protected carried(key: string): D | undefined {
    return this.held().get(key);
  }

  protected isOpen(key: string): boolean {
    return this.openRows.has(key);
  }

  private refresh(uris?: vscode.Uri[]): void {
    for (const provider of this.providers) provider.refresh(uris);
  }
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, at) => id === b[at]);

const INDICATORS_READ = { ...TOUCHING_READ, mods: true, modGroups: true } as const;

export class ModIndicatorDecorations extends OpenableRowDecorations<readonly ModIndicator[], keyof typeof INDICATORS_READ> {
  readonly providers: readonly IndicatorDecorationProvider[];
  // Each enabled mod's copy standing, kept path by path, and how many excluded files it holds, so a change derives again
  // only what it touched (ADR-0029, Consequences, bullet 5).
  private readonly kept = new Map<string, { readonly standing: KeptCopyStanding; excluded: number }>();

  constructor(instance: Pick<InstanceView, 'value' | 'subscribe'>, open: OpenRows, settings: WorkspaceSettings) {
    super(instance, open, INDICATORS_READ, sameIds);
    const carried = (uri: vscode.Uri) => {
      const key = uri.toString();
      return isModRow(uri) || !this.isOpen(key) ? this.carried(key) : undefined;
    };
    this.providers = MOD_INDICATORS.map((indicator) => new IndicatorDecorationProvider(indicator, (uri) => carried(uri)?.includes(indicator.id) === true, settings));
  }

  private indicatorsAfter(value: IndicatorsValue, entry: Mod, change: OriginsChange): ModIndicator[] {
    const origin = modOrigin(entry.name);
    const held = change === 'every' ? undefined : this.kept.get(entry.name);
    if (held === undefined || change === 'every') {
      const files = value.filesByMod.get(entry.name) ?? [];
      const whole = { standing: new KeptCopyStanding(origin), excluded: files.filter((file) => file.excluded).length };
      this.kept.set(entry.name, whole);
      return indicatorsFrom(whole.standing.update(value.stackedCopies, copyPathsOf(value, files)), whole.excluded > 0, entry.updateAvailable === true);
    }
    const own = change.own.find((changed) => sameOrigin(changed.origin, origin));
    if (own !== undefined) {
      const gained = new Set(own.gained);
      held.excluded += own.files.filter((file) => file.excluded).reduce((sum, file) => sum + (gained.has(file) ? 1 : -1), 0);
    }
    return indicatorsFrom(held.standing.update(value.stackedCopies, change.paths), held.excluded > 0, entry.updateAvailable === true);
  }

  // A disabled mod carries none. A separator carries each indicator a mod it holds carries.
  protected * ownedAgain(value: IndicatorsValue, change: OriginsChange): Iterable<Owned<readonly ModIndicator[]>> {
    if (change === 'every') this.kept.clear();
    const mods = touchedIn(value, change).flatMap((origin) => (origin.kind === 'mod' ? [origin.name] : []));
    for (const name of mods) {
      const entry = modEntryOf(value.mods, name);
      const uri = modRowUri(name);
      if (entry?.enabled !== true) this.kept.delete(name);
      yield [`mod/${name}`, entry?.enabled === true ? rowsOf({ uri, carried: this.indicatorsAfter(value, entry, change) }) : new Map()];
    }
    const separators = new Set(mods.flatMap((name) => separatorOf(value.modGroups, name) ?? []));
    for (const { separator, mods: held } of value.modGroups.groups) {
      if (!separators.has(separator.name) || held.length === 0) continue;
      const carried = held.flatMap(({ name }) => this.rows.get(modRowUri(name).toString()) ?? []);
      yield [`separator/${separator.name}`, rowsOf({ uri: separatorRowUri(separator.name), carried: MOD_INDICATORS.map(({ id }) => id).filter((id) => carried.includes(id)) })];
    }
  }
}
