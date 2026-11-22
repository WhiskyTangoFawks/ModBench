// mods.md, Indicators: a badge and a colour on a mod's row for each status that holds.

import * as vscode from 'vscode';
import type { FileOrigin, InstanceValue, InstanceView, ModGroups } from '../instanceLoader/instance';
import { indicatorsOf, MOD_INDICATORS, type IndicatorsValue, type ModIndicator } from './modFileStates';
import { originsTouched, type Touching } from './originsTouched';
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
  private readonly changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
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

/** A row VS Code asks a decoration of, and what it carries. */
export interface Row<D> {
  readonly uri: vscode.Uri;
  readonly carried: D;
}

/** The rows the origin or separator that `owner` names gives. */
export type Owned<D> = readonly [owner: string, rows: ReadonlyMap<string, Row<D>>];

/** Rows kept by the origin or separator that gives them, so a new value derives again the rows of the owners it touches. */
export class RowsByOwner<D> {
  private readonly rows = new Map<string, Row<D>>();
  private readonly byOwner = new Map<string, ReadonlyMap<string, Row<D>>>();

  constructor(private readonly same: (a: D, b: D) => boolean) {}

  get(key: string): D | undefined {
    return this.rows.get(key)?.carried;
  }

  /** Holds the rows each owner gives, in place of those it gave, and answers each row whose decoration changed. */
  hold(owned: Iterable<Owned<D>>): vscode.Uri[] {
    const changed: vscode.Uri[] = [];
    for (const [owner, now] of owned) {
      const was = this.byOwner.get(owner) ?? new Map<string, Row<D>>();
      for (const [key, row] of was) {
        if (now.has(key)) continue;
        this.rows.delete(key);
        changed.push(row.uri);
      }
      for (const [key, row] of now) {
        const prior = was.get(key);
        this.rows.set(key, row);
        if (prior === undefined || !this.same(prior.carried, row.carried)) changed.push(row.uri);
      }
      this.byOwner.set(owner, now);
    }
    return changed;
  }

  clear(): void {
    this.rows.clear();
    this.byOwner.clear();
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

/** The origins a value touches among those `value` lists: a mod by its entry, Overwrite as it is. */
export const touchedIn = (value: Pick<InstanceValue, 'mods'>, touched: 'every' | readonly FileOrigin[]): readonly FileOrigin[] => (touched !== 'every' ? touched
  : [...value.mods.flatMap((entry): FileOrigin[] => (entry.kind === 'mod' ? [{ kind: 'mod', name: entry.name }] : [])), { kind: 'runtimeOutput' }]);

/** VS Code never asks a decoration provider again on its own, so each fires for the rows a new instance value touches
 *  (ADR-0003), and for every row on a setting change or a row opened or closed. */
export abstract class OpenableRowDecorations<D, K extends keyof InstanceValue> implements vscode.Disposable {
  abstract readonly providers: readonly IndicatorDecorationProvider[];
  protected readonly rows: RowsByOwner<D>;
  private held: Pick<InstanceValue, K | keyof Touching> | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly instance: Pick<InstanceView, 'value' | 'subscribe'>,
    private readonly openRows: OpenRows,
    concerns: Readonly<Record<K | keyof Touching, true>>,
    same: (a: D, b: D) => boolean,
  ) {
    this.rows = new RowsByOwner(same);
    this.subscriptions = [
      instance.subscribe((value) => {
        const touched = originsTouched(this.held, value, concerns);
        if (touched === 'every') this.rows.clear();
        this.held = value;
        const changed = this.rows.hold(this.ownedAgain(value, touched));
        if (touched === 'every') this.refresh();
        else if (changed.length > 0) this.refresh(changed);
      }, concerns),
      openRows.onDidChange(() => { this.refresh(); }),
    ];
  }

  /** The rows each owner a value touches gives: the origins first, then each separator that holds one, from the rows held. */
  protected abstract ownedAgain(value: Pick<InstanceValue, K | keyof Touching>, touched: 'every' | readonly FileOrigin[]): Iterable<Owned<D>>;

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const provider of this.providers) provider.dispose();
  }

  protected carried(key: string): D | undefined {
    if (this.held === undefined) {
      this.held = this.instance.value;
      this.rows.hold(this.ownedAgain(this.instance.value, 'every'));
    }
    return this.rows.get(key);
  }

  protected isOpen(key: string): boolean {
    return this.openRows.has(key);
  }

  private refresh(uris?: vscode.Uri[]): void {
    for (const provider of this.providers) provider.refresh(uris);
  }
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, at) => id === b[at]);

const INDICATORS_READ = {
  mods: true, modGroups: true, filesByMod: true, foldersByMod: true, files: true, stackedCopies: true, archiveContents: true, loadsArchive: true,
} as const;

export class ModIndicatorDecorations extends OpenableRowDecorations<readonly ModIndicator[], keyof typeof INDICATORS_READ> {
  readonly providers: readonly IndicatorDecorationProvider[];

  constructor(instance: Pick<InstanceView, 'value' | 'subscribe'>, open: OpenRows, settings: WorkspaceSettings) {
    super(instance, open, INDICATORS_READ, sameIds);
    const carried = (uri: vscode.Uri) => {
      const key = uri.toString();
      return isModRow(uri) || !this.isOpen(key) ? this.carried(key) : undefined;
    };
    this.providers = MOD_INDICATORS.map((indicator) => new IndicatorDecorationProvider(indicator, (uri) => carried(uri)?.includes(indicator.id) === true, settings));
  }

  // A disabled mod carries none. A separator carries each indicator a mod it holds carries.
  protected * ownedAgain(value: IndicatorsValue, touched: 'every' | readonly FileOrigin[]): Iterable<Owned<readonly ModIndicator[]>> {
    const mods = touchedIn(value, touched).flatMap((origin) => (origin.kind === 'mod' ? [origin.name] : []));
    const entries = new Map(value.mods.flatMap((entry) => (entry.kind === 'mod' ? [[entry.name, entry] as const] : [])));
    for (const name of mods) {
      const entry = entries.get(name);
      const uri = modRowUri(name);
      yield [`mod/${name}`, entry?.enabled === true ? rowsOf({ uri, carried: indicatorsOf(value, entry, value.filesByMod.get(name) ?? []) }) : new Map()];
    }
    const separators = new Set(mods.flatMap((name) => separatorOf(value.modGroups, name) ?? []));
    for (const { separator, mods: held } of value.modGroups.groups) {
      if (!separators.has(separator.name) || held.length === 0) continue;
      const carried = held.flatMap(({ name }) => this.rows.get(modRowUri(name).toString()) ?? []);
      yield [`separator/${separator.name}`, rowsOf({ uri: separatorRowUri(separator.name), carried: MOD_INDICATORS.map(({ id }) => id).filter((id) => carried.includes(id)) })];
    }
  }
}
