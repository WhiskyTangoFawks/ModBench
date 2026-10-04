// mods.md, Indicators: a badge and a colour on a mod's row for each status that holds.

import * as vscode from 'vscode';
import type { InstanceValue, InstanceView, OriginFile } from '../instanceLoader/instance';
import { modOrigin, sameOrigin } from '../instanceLoader/fileConflictIndex';
import type { WorkspaceSettings } from './inactiveFiles';

/** Each indicator in the order mods.md's table lists them, with its name there. */
export const MOD_INDICATORS = [
  { id: 'overwritesLooseFiles', name: 'Overwrites loose files', badge: '\u2295', colour: 'modbench.modOverwritesLooseFiles' },
  { id: 'overwrittenLooseFiles', name: 'Overwritten loose files', badge: '\u2296', colour: 'modbench.modOverwrittenLooseFiles' },
  { id: 'redundant', name: 'Redundant', badge: '\u2297', colour: 'modbench.modRedundant' },
  { id: 'containsExcludedFiles', name: 'Contains excluded files', badge: '\u2298', colour: 'modbench.modContainsExcludedFiles' },
] as const;

export type ModIndicator = (typeof MOD_INDICATORS)[number]['id'];

type IndicatorsValue = Pick<InstanceValue, 'mods' | 'files' | 'filesByMod'>;

function indicatorsOf(value: IndicatorsValue, name: string, files: readonly OriginFile[]): ModIndicator[] {
  const gettable = files.filter((own) => !own.excluded);
  let wins = false;
  let loses = false;
  let gets = false;
  for (const { relativePath } of gettable) {
    const providers = value.files.get(relativePath)?.providers ?? [];
    const at = providers.findIndex((provider) => sameOrigin(provider, modOrigin(name)));
    if (at < providers.length - 1) wins = true;
    if (at > 0) loses = true;
    else gets = true;
  }
  const redundant = gettable.length > 0 && !gets;
  const holds: Record<ModIndicator, boolean> = {
    overwritesLooseFiles: wins,
    overwrittenLooseFiles: loses && !redundant,
    redundant,
    containsExcludedFiles: gettable.length < files.length,
  };
  return MOD_INDICATORS.flatMap(({ id }) => (holds[id] ? [id] : []));
}

/** The indicators each enabled mod carries, by its name, in the table's order. */
export function modIndicators(value: IndicatorsValue): ReadonlyMap<string, readonly ModIndicator[]> {
  const carriers = new Map<string, readonly ModIndicator[]>();
  for (const entry of value.mods) {
    if (entry.kind !== 'mod' || !entry.enabled) continue;
    carriers.set(entry.name, indicatorsOf(value, entry.name, value.filesByMod.get(entry.name) ?? []));
  }
  return carriers;
}

// Not `file:`: a decoration on a `file:` URI shows on the mod's folder in the Explorer too.
const MOD_ROW_SCHEME = 'modbench-mod';

/** The URI of a mod's row, which its indicators decorate. */
export const modRowUri = (name: string): vscode.Uri => vscode.Uri.from({ scheme: MOD_ROW_SCHEME, path: `/${name}` });

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
 *  never re-queries a provider, so each fires on every new instance value (ADR-0003) and every
 *  change to its settings. */
export class ModIndicatorDecorations implements vscode.Disposable {
  readonly providers: readonly IndicatorDecorationProvider[];
  private carriers: ReadonlyMap<string, readonly ModIndicator[]> | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(instance: Pick<InstanceView, 'value' | 'subscribe'>, settings: WorkspaceSettings) {
    const carried = (uri: vscode.Uri) => {
      this.carriers ??= new Map([...modIndicators(instance.value)].map(([name, held]) => [modRowUri(name).toString(), held]));
      return this.carriers.get(uri.toString());
    };
    this.providers = MOD_INDICATORS.map((indicator) => new IndicatorDecorationProvider(indicator, carried, settings));
    this.subscription = instance.subscribe(() => {
      this.carriers = undefined;
      for (const provider of this.providers) provider.refresh();
    });
  }

  dispose(): void {
    this.subscription.dispose();
    for (const provider of this.providers) provider.dispose();
  }
}
