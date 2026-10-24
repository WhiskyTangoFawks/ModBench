import type { ListenerThrows } from '../notificationStream';
import type { NotificationEvent } from '../apiClient';
import type { PluginAddress, PluginMetadata, PluginRecordTypeCount, RecordSummary } from '../index';
import type { components } from '../../wire/generated/api';
import type { InMemoryMEditClient } from './InMemoryMEditClient';
import { isReadFailed } from '../../wire/readFailed';

type CompiledPlugin = components['schemas']['CompiledPlugin'];

/** A `PluginMetadata` with every required wire member at its neutral value — a test naming only
 *  the fields it cares about needs no cast to reach the wire type. */
export function pluginMetadataFixture(overrides: Partial<PluginMetadata> & { name: string }): PluginMetadata {
  return {
    path: `/data/${overrides.name}`,
    loadOrderIndex: 0,
    isLight: false,
    isMaster: false,
    isBlueprint: false,
    masters: [],
    recordCount: 0,
    isImmutable: false,
    origin: 'SomeMod',
    missingMasters: [],
    lateMasters: [],
    inLoadOrder: true,
    hasMatchingRecords: true,
    isCompiledPlugin: false,
    hasParseFailure: false,
    pluginSourceUnreadable: null,
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

/** The record types mEdit answers `isContainer` for in the fixtures' game. */
export const CONTAINER_TYPES: ReadonlySet<string> = new Set(['qust', 'dial', 'cell', 'wrld']);

/** A `PluginRecordTypeCount` with every required wire member at its neutral value. */
export function recordTypeCountFixture(overrides: Partial<PluginRecordTypeCount> & { type: string }): PluginRecordTypeCount {
  return {
    count: 1,
    displayName: overrides.type,
    hasParseFailure: false,
    isCreatable: true,
    isContainer: CONTAINER_TYPES.has(overrides.type),
    ...overrides,
  };
}

/** One scripted page answering for every plugin a test browses, as mEdit's listing answers: each
 *  row is the asked plugin's own (Search's `plugin = $1`). */
export function listsForThePluginAsked(client: InMemoryMEditClient): InMemoryMEditClient {
  const scripted = client.getRecords.bind(client);
  client.getRecords = async (...asked) => {
    const [{ name: plugin, origin }] = asked;
    const page = await scripted(...asked);
    if (isReadFailed(page)) return page;
    return { ...page, items: page.items.map((record) => ({ ...record, plugin, origin })) };
  };
  return client;
}

/** A `CompiledPlugin` of `plugin` with no diagnostics unless given. */
export function compiledPluginFixture(
  { plugin, diagnostics = [] }: { plugin: PluginAddress; diagnostics?: CompiledPlugin['diagnostics'] },
): CompiledPlugin {
  return { ...plugin, diagnostics };
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

/** A `load-order-status` event of a settled, empty Ready load order at version 1. */
export function loadOrderStatusEventFixture(
  overrides: Partial<NonNullable<NotificationEvent['loadOrderStatus']>> = {},
): NotificationEvent {
  return notificationEventFixture({
    kind: 'load-order-status',
    loadOrderStatus: {
      state: 'Ready', totalPlugins: 0, activePlugins: 0, indexedPlugins: [], conflictsComputed: true, failures: [], version: 1, ...overrides,
    },
  });
}

export const IGNORED_THROWS: ListenerThrows = { threw: () => {}, recovered: () => {} };

export function recordedThrows() {
  const threw: { message: string; detail: string }[] = [];
  const recovered: object[] = [];
  const sink: ListenerThrows = {
    threw: (_listener, message, detail) => { threw.push({ message, detail }); },
    recovered: (listener) => { recovered.push(listener); },
  };
  return { sink, threw, recovered };
}
