// mods.md, Indicators: a badge and a colour on a mod's row for each status that holds.

import * as vscode from 'vscode';
import type { InstanceValue, InstanceView, Mod, OriginFile } from '../instanceLoader/instance';
import { fileOrderConflictOf, modOrigin, outranksACopy, winsPath } from '../instanceLoader/fileConflictIndex';
import { onSettingChange } from '../drivingLib/setting';
import type { WorkspaceSettings } from './workspaceSettings';

/** Each indicator in the order mods.md's table lists them, with its name there.
 *  @public Read by packageJson.test, which holds package.json to it. */
export const MOD_INDICATORS = [
  { id: 'overwritesLooseFiles', name: 'Overwrites loose files', badge: '\u2295', colour: 'modbench.modOverwritesLooseFiles' },
  { id: 'overwrittenLooseFiles', name: 'Overwritten loose files', badge: '\u2296', colour: 'modbench.modOverwrittenLooseFiles' },
  { id: 'redundant', name: 'Redundant', badge: '\u2297', colour: 'modbench.modRedundant' },
  { id: 'containsExcludedFiles', name: 'Contains excluded files', badge: '\u2298', colour: 'modbench.modContainsExcludedFiles' },
  { id: 'updateAvailable', name: 'Update available', badge: '\u2191', colour: 'modbench.modUpdateAvailable' },
] as const;

type ModIndicator = (typeof MOD_INDICATORS)[number]['id'];

/** The table's Publisher tag row: each publisher tag is an indicator of its own, with the badge its publisher declares,
 *  under one pair of settings and one colour.
 *  @public Read by packageJson.test, which holds package.json to it. */
export const PUBLISHER_TAG_INDICATOR = { id: 'publisherTag', colour: 'modbench.modPublisherTag' } as const;

type IndicatorId = ModIndicator | typeof PUBLISHER_TAG_INDICATOR.id;

type IndicatorsValue = Pick<InstanceValue, 'mods' | 'modGroups' | 'files' | 'filesByMod'>;

function indicatorsOf(value: IndicatorsValue, { name, updateAvailable }: Mod, files: readonly OriginFile[]): ModIndicator[] {
  const own = modOrigin(name);
  const entries = files.filter((file) => !file.excluded).map((file) => value.files.get(file.relativePath));
  const gets = entries.some((entry) => winsPath(entry, own));
  const loses = entries.some((entry) => fileOrderConflictOf(entry, own) === 'loses');
  const redundant = loses && !gets;
  const holds: Record<ModIndicator, boolean> = {
    overwritesLooseFiles: entries.some((entry) => outranksACopy(entry, own)),
    overwrittenLooseFiles: loses && !redundant,
    redundant,
    containsExcludedFiles: files.some((file) => file.excluded),
    updateAvailable: updateAvailable === true,
  };
  return MOD_INDICATORS.flatMap(({ id }) => (holds[id] ? [id] : []));
}

function modIndicators(value: IndicatorsValue): ReadonlyMap<string, readonly ModIndicator[]> {
  const carriers = new Map<string, readonly ModIndicator[]>();
  for (const entry of value.mods) {
    if (entry.kind !== 'mod' || !entry.enabled) continue;
    carriers.set(entry.name, indicatorsOf(value, entry, value.filesByMod.get(entry.name) ?? []));
  }
  return carriers;
}

interface Carriers {
  readonly mods: ReadonlyMap<string, readonly ModIndicator[]>;
  /** Each separator that holds a mod, with the indicators of the mods it holds. */
  readonly separators: ReadonlyMap<string, readonly ModIndicator[]>;
}

function carriersOf(value: IndicatorsValue): Carriers {
  const byName = modIndicators(value);
  const separators = new Map<string, readonly ModIndicator[]>();
  for (const { separator, mods } of value.modGroups.groups) {
    if (mods.length === 0) continue;
    const held = mods.flatMap((own) => byName.get(own.name) ?? []);
    separators.set(separatorRowUri(separator.name).toString(), MOD_INDICATORS.map(({ id }) => id).filter((id) => held.includes(id)));
  }
  return { mods: new Map([...byName].map(([name, held]) => [modRowUri(name).toString(), held])), separators };
}

// Not `file:`: a decoration on a `file:` URI shows on the mod's folder in the Explorer too.
const MOD_ROW_SCHEME = 'modbench-mod';
const SEPARATOR_ROW_SCHEME = 'modbench-separator';

export const modRowUri = (name: string): vscode.Uri => vscode.Uri.from({ scheme: MOD_ROW_SCHEME, path: `/${name}` });

export const separatorRowUri = (name: string): vscode.Uri => vscode.Uri.from({ scheme: SEPARATOR_ROW_SCHEME, path: `/${name}` });

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
  private readonly changed = new vscode.EventEmitter<undefined>();
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

  refresh(): void {
    this.changed.fire(undefined);
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

/** VS Code takes one decoration from each provider and joins their badges, and never re-queries one,
 *  so each fires on every new instance value (ADR-0003), setting change, and separator opened or closed. */
export class ModIndicatorDecorations implements vscode.Disposable {
  readonly providers: readonly IndicatorDecorationProvider[];
  private carriers: Carriers | undefined;
  private readonly expanded = new Set<string>();
  private readonly subscription: vscode.Disposable;

  constructor(instance: Pick<InstanceView, 'value' | 'subscribe'>, settings: WorkspaceSettings) {
    const carried = (uri: vscode.Uri) => {
      this.carriers ??= carriersOf(instance.value);
      const key = uri.toString();
      return this.carriers.mods.get(key) ?? (this.expanded.has(key) ? undefined : this.carriers.separators.get(key));
    };
    this.providers = MOD_INDICATORS.map((indicator) => new IndicatorDecorationProvider(indicator, (uri) => carried(uri)?.includes(indicator.id) === true, settings));
    this.subscription = instance.subscribe((value) => {
      this.carriers = carriersOf(value);
      for (const key of this.expanded) if (!this.carriers.separators.has(key)) this.expanded.delete(key);
      this.refresh();
    });
  }

  expandedRow(uri: vscode.Uri): void {
    this.expanded.add(uri.toString());
    this.refresh();
  }

  collapsedRow(uri: vscode.Uri): void {
    this.expanded.delete(uri.toString());
    this.refresh();
  }

  private refresh(): void {
    for (const provider of this.providers) provider.refresh();
  }

  dispose(): void {
    this.subscription.dispose();
    for (const provider of this.providers) provider.dispose();
  }
}
