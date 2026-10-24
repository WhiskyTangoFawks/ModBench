import * as vscode from 'vscode';
import { originLabel } from '../instanceLoader/fileConflictIndex';
import type { InstanceValue, Instance, PublisherTag, PublisherTagChange } from '../instanceLoader/instance';
import type { ModCommands, PublisherTagRow } from '../modCommands/modCommands';
import type { Reporter } from '../ports/reporter';
import { argumentOfKind, registerAgentGesture, type AgentGesture } from '../drivingLib/agentGesture';
import { pluralArgument, selectionArgument, type GestureEntry } from '../drivingLib/gestureEntry';
import { pickWithMarked } from '../drivingLib/pickWithMarked';
import { fileLabel } from './modFiles';
import { tagsHeldAt } from './tagsHeldAt';
import { runModsWriting } from './gestureEntry';
import type { ModlistNode } from './ModListProvider';

type PublisherState = Pick<InstanceValue, 'publisherConfiguration' | 'paths'>;

function pathOf({ paths }: Pick<InstanceValue, 'paths'>, row: ModlistNode): string | undefined {
  if (row.kind === 'mod') return paths.modDirs.get(row.mod.name);
  if (row.kind === 'file') return row.file.path;
  return row.kind === 'folder' ? row.folder.path : undefined;
}

const tagsHeldBy = (value: PublisherState, row: ModlistNode): readonly PublisherTag[] => tagsHeldAt(value, pathOf(value, row));

/** What the publisher tag items wait on, as `modbench.mod.<name>` keys. A publisher whose configuration is not read offers none. */
export function publisherKeyContext(
  value: PublisherState & Pick<InstanceValue, 'publisherTags'>, selection: readonly ModlistNode[],
): { hasPublisher: boolean; hasPathPublisher: boolean; holdsTaggableRow: boolean; holdsPublisherTag: boolean } {
  const read = value.publisherConfiguration.kind === 'read';
  const taggable = selection.filter((row) => row.kind === 'mod' || ((row.kind === 'file' || row.kind === 'folder') && row.origin.kind === 'mod'));
  return {
    hasPublisher: read,
    hasPathPublisher: read && value.publisherTags.some(({ marksPaths }) => marksPaths),
    holdsTaggableRow: taggable.length > 0,
    holdsPublisherTag: taggable.some((row) => tagsHeldBy(value, row).length > 0),
  };
}

const rowOf = (row: ModlistNode): PublisherTagRow | undefined => {
  if (row.kind === 'mod') return { origin: { kind: 'mod', name: row.mod.name } };
  if (row.kind === 'file') return row.ref;
  if (row.kind === 'folder') return { origin: row.origin, relativePath: row.folder.relativePath };
  return undefined;
};

const selectedRows = (entry: GestureEntry<ModlistNode>): ModlistNode[] => {
  const mods = pluralArgument(entry, 'mod');
  return mods.length > 0 ? mods : selectionArgument(entry, 'file', 'folder');
};

const labelOf = ({ origin, relativePath }: PublisherTagRow): string =>
  (relativePath === undefined ? originLabel(origin) : fileLabel({ origin, relativePath }));

interface Given {
  readonly tag: string;
  readonly rows: readonly PublisherTagRow[];
}

export function registerPublisherTagCommands(
  commands: Pick<ModCommands, 'changePublisherTag'>, instance: Pick<Instance, 'value' | 'refresh'>, viewSelection: () => readonly ModlistNode[], reporter: Reporter,
): vscode.Disposable[] {
  const gesture = (change: PublisherTagChange): AgentGesture<ModlistNode, Given, Awaited<ReturnType<ModCommands['changePublisherTag']>>, { tag: string }> => ({
    fromView: async (entry) => {
      const selected = selectedRows(entry);
      const rows = selected.flatMap((row) => rowOf(row) ?? []);
      const { value } = instance;
      const offered = value.publisherTags.filter((tag) => (change === 'add'
        ? tag.marksPaths || selected.every(({ kind }) => kind === 'mod')
        : selected.some((row) => tagsHeldBy(value, row).includes(tag))));
      if (rows.length === 0 || offered.length === 0) return undefined;
      const picked = await pickWithMarked(offered.map(({ name, badge }) => ({ label: name, description: badge })), undefined, `${change === 'add' ? 'Add' : 'Remove'} publisher tag…`);
      return picked && { tag: picked.label, rows };
    },
    fromAgent: ({ argument, options }) => ({
      tag: options.tag,
      rows: argument.map((one) => {
        const given = argumentOfKind(one, 'mod', 'file');
        return given.kind === 'mod' ? { origin: { kind: 'mod', name: given.name } } : { origin: given.origin, relativePath: given.relativePath };
      }),
    }),
    run: ({ tag, rows }) => runModsWriting(instance, () => commands.changePublisherTag(change, tag, rows)),
    report: (result, { tag, rows }) => {
      if (!result.applied) {
        reporter.report('error', `Failed to ${change} ${tag}.`, result.refusal);
        return;
      }
      const noun = rows.every(({ relativePath }) => relativePath === undefined) ? 'mod rows' : 'file and folder rows';
      reporter.selectionOutcome(`Could not ${change} ${tag} on ${result.outcome.refused.length} of ${rows.length} ${noun}.`, result.outcome, labelOf);
    },
  });
  return [
    registerAgentGesture('modbench.mod.addPublisherTag', viewSelection, gesture('add')),
    registerAgentGesture('modbench.mod.removePublisherTag', viewSelection, gesture('remove')),
  ];
}
