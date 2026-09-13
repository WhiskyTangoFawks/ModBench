import type { CompileResult, NotificationEvent, PluginMetadata, RecordSummary, ReferenceResult } from '../index';

/** A `PluginMetadata` with every required wire member at its neutral value — a test naming only
 *  the fields it cares about needs no cast to reach the wire type. */
export function pluginMetadataFixture(overrides: Partial<PluginMetadata> & { name: string }): PluginMetadata {
  return {
    path: `/data/${overrides.name}`,
    loadOrderIndex: 0,
    isLight: false,
    isMaster: false,
    masters: [],
    recordCount: 0,
    isImmutable: false,
    participates: true,
    origin: 'SomeMod',
    masterIssues: [],
    inLoadOrder: true,
    enabled: true,
    winning: true,
    hasMatchingRecords: true,
    isTracked: false,
    hasParseFailure: false,
    ...overrides,
  };
}

/** A `ReferenceResult` with every required wire member at its neutral value. */
export function referenceResultFixture(
  overrides: Partial<ReferenceResult> & { formKey: string },
): ReferenceResult {
  return {
    plugin: 'MyPatch.esp',
    fieldPath: 'FNAM',
    recordType: 'npc_',
    origin: 'SomeMod',
    ...overrides,
  };
}

/** A `RecordSummary` with every required wire member at its neutral value. */
export function recordSummaryFixture(overrides: Partial<RecordSummary> = {}): RecordSummary {
  return {
    formKey: '000001:A.esp',
    plugin: 'A.esp',
    loadOrderIndex: 0,
    isWinner: true,
    editorId: 'TheRecord',
    origin: 'SomeMod',
    workingTreeState: 'None',
    hasContainerChildren: false,
    hasParseFailure: false,
    ...overrides,
  };
}

/** A `CompileResult` with every required wire member at its neutral (successful, no-diagnostic)
 *  value. */
export function compileResultFixture(overrides: Partial<CompileResult> = {}): CompileResult {
  return {
    succeeded: true,
    refusalReason: null,
    diagnostics: [],
    masters: [],
    eslContradiction: false,
    refusal: 'None',
    ...overrides,
  };
}

/** A `NotificationEvent` with every required wire member at its neutral value. */
export function notificationEventFixture(
  overrides: Partial<NotificationEvent> & { kind: string },
): NotificationEvent {
  return {
    plugin: 'MyMod.esp',
    origin: 'SomeMod',
    keys: [],
    sequence: 0,
    ...overrides,
  };
}
