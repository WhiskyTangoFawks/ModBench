import * as vscode from 'vscode';
import { modbenchDiagnostic } from '../drivingLib/modbenchDiagnostic';
import type { InstanceView } from '../instanceLoader/instance';
import type { ModStatus } from '../manifestAdapter/manifestAdapter';
import type { ModStatuses } from '../modStatus/modStatuses';

type UnshippableReason = (folder: string, pathInFolder: string, mod: string, heldByPackage: boolean) => string | undefined;

interface Unshippable {
  readonly path: string;
  readonly reason: string;
}

const wording = (mod: string, [first, ...rest]: readonly [Unshippable, ...Unshippable[]]): string =>
  rest.length === 0
    ? `1 file of "${mod}" has no way to ship: '${first.path}': ${first.reason}.`
    : `${rest.length + 1} files of "${mod}" have no way to ship, such as '${first.path}': ${first.reason}.`;

function messageOf(status: ModStatus, folder: string, heldByPackage: ReadonlySet<string>, reasonFor: UnshippableReason): string | undefined {
  const [first, ...rest] = status.unpackaged.flatMap((path) => {
    const reason = reasonFor(folder, path, status.mod, heldByPackage.has(path));
    return reason === undefined ? [] : [{ path, reason }];
  });
  return first === undefined ? undefined : wording(status.mod, [first, ...rest]);
}

interface Judged {
  readonly reasonFor: UnshippableReason;
  readonly folder: string;
  readonly unpackaged: readonly string[];
  readonly packaged: readonly string[];
  readonly message: string | undefined;
}

const sameFiles = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((path, at) => path === b[at]);

/** The Problems panel's view of the files a publisher has no way to ship (publishing.md, What ships, story 2): a warning
 *  for each mod, on the publisher's configuration. */
export class UnshippableProblems {
  private readonly following: vscode.Disposable[];
  private judged = new Map<string, Judged>();

  constructor(
    private readonly collection: vscode.DiagnosticCollection,
    private readonly instance: Pick<InstanceView, 'value' | 'subscribe'>,
    private readonly statuses: Pick<ModStatuses, 'current' | 'heldByPackage' | 'onDidChange'>,
  ) {
    this.following = [instance.subscribe(() => { void this.show(); }), statuses.onDidChange(() => { void this.show(); })];
    void this.show();
  }

  dispose(): void {
    for (const following of this.following) following.dispose();
    this.collection.dispose();
  }

  private async show(): Promise<void> {
    const statuses = await this.statuses.current();
    const { publisherConfiguration, modFolders } = this.instance.value;
    this.collection.clear();
    if (publisherConfiguration.kind !== 'read') return;
    const { file, reason } = publisherConfiguration.unshippable;
    const folders = new Map((modFolders ?? []).map((folder) => [folder.modName, folder.path]));
    const judged = new Map<string, Judged>();
    for (const status of statuses.values()) {
      const folder = folders.get(status.mod);
      if (folder === undefined) continue;
      const before = this.judged.get(status.mod);
      const heldByPackage = this.statuses.heldByPackage(status.mod);
      const packaged = status.unpackaged.filter((path) => heldByPackage.has(path));
      const kept = before !== undefined && before.reasonFor === reason && before.folder === folder && sameFiles(before.unpackaged, status.unpackaged) && sameFiles(before.packaged, packaged);
      judged.set(status.mod, kept ? before : { reasonFor: reason, folder, unpackaged: status.unpackaged, packaged, message: messageOf(status, folder, heldByPackage, reason) });
    }
    this.judged = judged;
    const messages = [...judged.values()].flatMap(({ message }) => (message === undefined ? [] : [message]));
    if (messages.length === 0) return;
    const range = new vscode.Range(0, 0, 0, Number.MAX_SAFE_INTEGER);
    this.collection.set(vscode.Uri.file(file), messages.map((message) => modbenchDiagnostic(range, message, vscode.DiagnosticSeverity.Warning)));
  }
}
