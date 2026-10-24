import { pluginKey } from '../../loadOrderFileCodec/pluginsText';
import type { PluginEntry, PluginsProvided } from '../instanceAdapter';
import { readPluginsProvided, type ReadingSource } from '../instanceReading';
import { programVersions, type ProgramVersion, type ProgramVersions } from '../gameFolder/programVersions';
import type { ConditionFacts, Known } from './engineProtocol';

// The reference installer reads the version of a script extender it does not find as no version at all: each part 0.
const NO_VERSION = '0.0.0.0';

// A plugin is active as the mod manager's plugin list has it: present, and enabled by its line or loaded with no line.
function pluginStates(provided: PluginsProvided, order: readonly PluginEntry[]): ConditionFacts['plugins'] {
  if (provided.kind === 'unresolved') return { unknown: 'the game folder was not found' };
  if (provided.kind === 'unreadable') return { unknown: provided.reason };
  const enabled = new Set([...order.filter((entry) => entry.enabled).map((entry) => entry.name), ...provided.loadedWithNoLine].map(pluginKey));
  const present = [...provided.plugins.values()];
  return { known: { present, active: present.filter((name) => enabled.has(pluginKey(name))) } };
}

function versionFact(version: ProgramVersion, notFound: (program: string) => Known<string>): Known<string> {
  switch (version.kind) {
    case 'read': return { known: version.version };
    case 'notFound': return notFound(version.program);
    case 'noVersionResource': return { unknown: `${version.program} has no version resource` };
    case 'notAProgram': return { unknown: `${version.program} is not a Windows program` };
    case 'unreadable': return { unknown: `${version.program} cannot be read: ${version.why}` };
  }
}

function versionFacts(versions: ProgramVersions): Pick<ConditionFacts, 'gameVersion' | 'extenderVersion'> {
  if (versions.kind !== 'found') {
    const unknown = { unknown: versions.kind === 'unresolved' ? 'the game folder was not found' : 'Modbench knows no program of this game' };
    return { gameVersion: unknown, extenderVersion: unknown };
  }
  return {
    gameVersion: versionFact(versions.game, (program) => ({ unknown: `${program} is not in the game folder` })),
    extenderVersion: versionFact(versions.extender, () => ({ known: NO_VERSION })),
  };
}

/** What a FOMOD's conditions read of the instance, read now. */
export async function conditionFacts(source: ReadingSource): Promise<ConditionFacts> {
  const settings = await source.settings();
  const [provided, order, versions] = await Promise.all([
    readPluginsProvided(source, settings.profile), source.pluginOrder(settings.profile),
    settings.gameFolder().then((gameFolder) => programVersions(gameFolder, settings.gameRelease)),
  ]);
  return { plugins: pluginStates(provided, order), ...versionFacts(versions) };
}
