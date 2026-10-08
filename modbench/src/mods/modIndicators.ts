// mods.md, Indicators: a badge and a colour on a mod's row for each status that holds.

import * as vscode from 'vscode';
import type { InstanceValue, InstanceView, OriginFile } from '../instanceLoader/instance';
import { modOrigin, sameOrigin } from '../instanceLoader/fileConflictIndex';
import { groupModlist } from './modlistTree';
import type { WorkspaceSettings } from './workspaceSettings';

/** Each indicator in the order mods.md's table lists them, with its name there.
 *  @public Read by packageJson.test, which holds package.json to it. */
export const MOD_INDICATORS = [
  { id: 'overwritesLooseFiles', name: 'Overwrites loose files', badge: '\u2295', colour: 'modbench.modOverwritesLooseFiles' },
  { id: 'overwrittenLooseFiles', name: 'Overwritten loose files', badge: '\u2296', colour: 'modbench.modOverwrittenLooseFiles' },
  { id: 'redundant', name: 'Redundant', badge: '\u2297', colour: 'modbench.modRedundant' },
  { id: 'containsExcludedFiles', name: 'Contains excluded files', badge: '\u2298', colour: 'modbench.modContainsExcludedFiles' },
] as const;

export type ModIndicator = (typeof MOD_INDICATORS)[number]['id'];

type IndicatorsValue = Pick<InstanceValue, 'mods' | 'files' | 'filesByMod'>;

function indicatorsOf(value: IndicatorsValue, name: string, files: readonly OriginFile[]): ModIndicator[] {
  let wins = false;
  let loses = false;
  let gets = false;
  let provides = false;
  for (const { relativePath } of files.filter((own) => !own.excluded)) {
    const providers = value.files.get(relativePath)?.providers ?? [];
    const at = providers.findIndex((provider) => sameOrigin(provider, modOrigin(name)));
    if (at === -1) continue;
    provides = true;
    if (at < providers.length - 1) wins = true;
    if (at > 0) loses = true;
    else gets = true;
  }
  const redundant = provides && !gets;
  const holds: Record<ModIndicator, boolean> = {
    overwritesLooseFiles: wins,
    overwrittenLooseFiles: loses && !redundant,
    redundant,
    containsExcludedFiles: files.some((own) => own.excluded),
  };
  return MOD_INDICATORS.flatMap(({ id }) => (holds[id] ? [id] : []));
}

function modIndicators(value: IndicatorsValue): ReadonlyMap<string, readonly ModIndicator[]> {
  const carriers = new Map<string, readonly ModIndicator[]>();
  for (const entry of value.mods) {
    if (entry.kind !== 'mod' || !entry.enabled) continue;
    carriers.set(entry.name, indicatorsOf(value, entry.name, value.filesByMod.get(entry.name) ?? []));
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
  for (const { separator, mods } of groupModlist([...value.mods]).groups) {
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
export const indicatorSetting = (id: ModIndicator, part: 'badge' | 'colour'): string => `modbench.mods.indicators.${id}.${part}`;

type Indicator = (typeof MOD_INDICATORS)[number];

const PARTS = ['badge', 'colour'] as const;

class IndicatorDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly indicator: Indicator,
    private readonly carried: (uri: vscode.Uri) => readonly ModIndicator[] | undefined,
    private readonly settings: WorkspaceSettings,
  ) {
    this.subscription = settings.onDidChangeConfiguration((change) => {
      if (PARTS.some((part) => change.affectsConfiguration(indicatorSetting(indicator.id, part)))) this.refresh();
    });
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const { id, name, badge, colour } = this.indicator;
    if (!this.carried(uri)?.includes(id)) return undefined;
    const configuration = this.settings.getConfiguration();
    const [badgeOn, colourOn] = PARTS.map((part) => configuration.get(indicatorSetting(id, part)) === true);
    if (!badgeOn && !colourOn) return undefined;
    return { badge: badgeOn ? badge : undefined, color: colourOn ? new vscode.ThemeColor(colour) : undefined, tooltip: name };
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

/** A provider per indicator: VS Code takes one decoration from each, and joins their badges. It
 *  never re-queries a provider, so each fires on every new instance value (ADR-0003), setting
 *  change, and separator opened or closed. A collapsed separator carries the indicators of the mods
 *  beneath it (MO2's collapsed separator). */
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
    this.providers = MOD_INDICATORS.map((indicator) => new IndicatorDecorationProvider(indicator, carried, settings));
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
