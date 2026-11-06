import * as vscode from 'vscode';
import { reportPartial } from '../drivingLib/agentGesture';
import { renameOutcome } from '../drivingLib/renameOutcome';
import type { InstanceAdapter, RenamedSymbol } from '../instanceAdapter/instanceAdapter';
import type { Instance } from '../instanceLoader/instance';
import type { DownloadedFileCommands } from '../downloadedFileCommands/downloads';
import type { InstanceCommands } from '../instanceCommands/instanceCommands';
import type { EntryRenameCommands, RenameEditing } from '../modCommands/renameEntry';
import type { PluginCommands } from '../pluginCommands/plugins';
import type { ChangeResult } from '../ports/changeResult';
import type { Reporter } from '../ports/reporter';
import { heldTexts, samePath, type FileChanges } from '../symbolNames/symbolNames';
import { errorMessage } from '../ports/errorMessage';
import { applyAnswered } from '../textDocuments/applyAnswered';
import { unsavedTexts } from '../textDocuments/heldText';
import type { SourceEditing } from '../textDocuments/sourceEditing';
import type { PluginAddress } from '../wire/pluginAddress';

/** A file or folder VS Code renames, by its absolute path before and after. */
export interface FileRename {
  readonly from: string;
  readonly to: string;
}

export interface Following {
  /** Settles once every owner has planned against the old names, when VS Code may rename. */
  readonly planned: Promise<void>;
  readonly done: Promise<void>;
}

interface FollowRenameDeps {
  readonly adapter: Pick<InstanceAdapter, 'renamedSymbol'>;
  readonly plugins: Pick<PluginCommands, 'renamePlugin'>;
  readonly entries: Pick<EntryRenameCommands, 'renameMod' | 'renameSeparator'>;
  readonly downloads: Pick<DownloadedFileCommands, 'renameDownloadedFile'>;
  readonly profiles: Pick<InstanceCommands, 'renameProfile'>;
  readonly source: SourceEditing;
  readonly instance: Pick<Instance, 'quiet'>;
  readonly reporter: Reporter;
}

type Editing = (touched: readonly PluginAddress[]) => RenameEditing;

// The reason change() is given for an edit VS Code's rename never let apply; the not-landed warning says it instead.
const NOT_RENAMED = 'VS Code did not rename it.';

function reportFollowed(reporter: Reporter, named: string, newName: string, result: ChangeResult | { applied: false; refusal: string; detail?: string }, definition: string): void {
  if (!result.applied && 'refusal' in result) {
    reporter.report('warning', `${named} was renamed to "${newName}", and no reference to it followed: ${result.refusal}`, 'detail' in result ? result.detail : undefined);
    return;
  }
  const outcome = renameOutcome(result, { named, newName, landed: newName, definition, couldNot: `Could not carry the rename of ${named} to "${newName}"` });
  if (outcome.applied) reportPartial(reporter, outcome.partial);
  else reporter.report('error', outcome.refusal, outcome.detail);
}

interface Followed {
  readonly named: string;
  /** What the follow says once VS Code has renamed the file (symbols.md, The features, story 9). */
  readonly report: () => void;
}

// What each kind's definition writes last, as a failed rename names it.
const DEFINITIONS = { mod: 'its lines', separator: 'its lines', downloadedFile: 'its file and its metadata', profile: 'its folder' } as const;

async function followed({ plugins, entries, downloads, profiles, reporter }: FollowRenameDeps, symbol: RenamedSymbol, editing: Editing): Promise<Followed> {
  if (symbol.kind === 'plugin') {
    const { plugin, to } = symbol;
    const named = `"${plugin.name}" (${plugin.origin})`;
    const result = await plugins.renamePlugin(editing([plugin, { name: to, origin: plugin.origin }]), plugin, to);
    return { named, report: () => { reportFollowed(reporter, named, to, result, 'the files named for it and its lines'); } };
  }
  const { entry, to } = symbol;
  const named = `"${entry.name}"`;
  if (to.kind !== entry.kind) {
    return {
      named,
      report: () => { reporter.report('warning', `${named} was renamed to "${to.name}", which names a ${to.kind} and not a ${entry.kind}, so no reference to it followed.`); },
    };
  }
  const renames = { mod: entries.renameMod, separator: entries.renameSeparator, downloadedFile: downloads.renameDownloadedFile, profile: profiles.renameProfile };
  const result = await renames[entry.kind](editing([]), entry.name, to.name);
  const landedAs = result.applied && 'name' in result && typeof result.name === 'string' ? result.name : to.name;
  return { named, report: () => { reportFollowed(reporter, named, landedAs, result, DEFINITIONS[entry.kind]); } };
}

/** commands.md, System commands, `modbench.symbol.followRename`: carries each reference to what VS Code renames. The
 *  owners plan against the old names before `landed`, VS Code's rename, and apply their edit and commit after it. */
export function followRenames(deps: FollowRenameDeps) {
  return (renames: readonly FileRename[], landed: Promise<boolean>): Following => {
    let allPlanned!: () => void;
    const planned = new Promise<void>((resolve) => { allPlanned = resolve; });
    const done = (async () => {
      const symbols = (await Promise.all(renames.map(({ from, to }) => deps.adapter.renamedSymbol(from, to)))).filter((symbol) => symbol !== undefined);
      let unplanned = symbols.length;
      if (unplanned === 0) return;
      await deps.source.oneAtATime(() => deps.instance.quiet(async () => {
        const held = heldTexts(unsavedTexts());
        await Promise.all(symbols.map(async (symbol) => {
          let isPlanned = false;
          const hasPlanned = () => {
            if (isPlanned) return;
            isPlanned = true;
            unplanned -= 1;
            if (unplanned === 0) allPlanned();
          };
          const editing: Editing = (touched) => ({
            held,
            apply: async (changes: readonly FileChanges[]) => {
              hasPlanned();
              return await landed ? applyAnswered(deps.source, changes, touched) : NOT_RENAMED;
            },
          });
          let outcome: Followed;
          try {
            outcome = await followed(deps, symbol, editing);
          } finally {
            hasPlanned();
          }
          if (await landed) outcome.report();
          else deps.reporter.report('warning', `VS Code did not report renaming ${outcome.named}, so no reference to it followed.`);
        }));
      }));
    })().catch((error: unknown) => { deps.reporter.report('error', 'Could not carry the references to what VS Code renamed.', errorMessage(error)); });
    return { planned: Promise.race([planned, done]), done };
  };
}

/** Whether VS Code renamed each of `renames`: true once it says so, false past `within` milliseconds. */
export function landing(renames: readonly FileRename[], within: number): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = (landed: boolean) => {
      heard.dispose();
      clearTimeout(timer);
      resolve(landed);
    };
    const heard = vscode.workspace.onDidRenameFiles(({ files }) => {
      if (renames.every(({ from, to }) => files.some(({ oldUri, newUri }) => samePath(oldUri.fsPath, from) && samePath(newUri.fsPath, to)))) settle(true);
    });
    const timer = setTimeout(() => { settle(false); }, within);
  });
}

// VS Code cancels a rename's participants past `files.participants.timeout`, and renames after them.
const RENAME_AFTER_PARTICIPANTS_MS = 10_000;

/** Fires `modbench.symbol.followRename` on each rename VS Code is about to make, and holds the rename until every owner
 *  has planned. */
export function registerFollowRename(follow: ReturnType<typeof followRenames>): vscode.Disposable {
  const run = (renames: readonly FileRename[]) => {
    const participants = vscode.workspace.getConfiguration('files').get<number>('participants.timeout', 60_000);
    return follow(renames, landing(renames, participants + RENAME_AFTER_PARTICIPANTS_MS));
  };
  return vscode.Disposable.from(
    vscode.commands.registerCommand('modbench.symbol.followRename', (from: string, to: string) => run([{ from, to }]).done),
    vscode.workspace.onWillRenameFiles((event) => {
      const renames = event.files.filter(({ oldUri }) => oldUri.scheme === 'file').map(({ oldUri, newUri }) => ({ from: oldUri.fsPath, to: newUri.fsPath }));
      event.waitUntil(run(renames).planned);
    }),
  );
}
