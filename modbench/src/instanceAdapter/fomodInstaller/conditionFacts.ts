import { pluginKey } from '../../loadOrderFileCodec/pluginsText';
import type { PluginEntry, PluginsProvided } from '../instanceAdapter';
import { readPluginsProvided, type ReadingSource } from '../instanceReading';
import type { ConditionFacts } from './engineProtocol';

const UNREAD_VERSION = { unknown: 'Modbench reads no program\'s version' };

// A plugin is active as the mod manager's plugin list has it: present, and enabled by its line or loaded with no line.
function pluginStates(provided: PluginsProvided, order: readonly PluginEntry[]): ConditionFacts['plugins'] {
  if (provided.kind === 'unresolved') return { unknown: 'the game folder was not found' };
  if (provided.kind === 'unreadable') return { unknown: provided.reason };
  const enabled = new Set([...order.filter((entry) => entry.enabled).map((entry) => entry.name), ...provided.loadedWithNoLine].map(pluginKey));
  const present = [...provided.plugins.values()];
  return { known: { present, active: present.filter((name) => enabled.has(pluginKey(name))) } };
}

/** What a FOMOD's conditions read of the instance, read now. */
export async function conditionFacts(source: ReadingSource): Promise<ConditionFacts> {
  const { profile } = await source.settings();
  const [provided, order] = await Promise.all([readPluginsProvided(source, profile), source.pluginOrder(profile)]);
  return { plugins: pluginStates(provided, order), gameVersion: UNREAD_VERSION, extenderVersion: UNREAD_VERSION };
}
