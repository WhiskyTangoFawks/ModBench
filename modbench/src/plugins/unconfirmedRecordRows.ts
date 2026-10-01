import type { CopyItem, CopyMode, MEditClient, PluginAddress, RecordAddress } from '../client';
import { pluginAddressKey } from './trackedRepositories';

export const MARK_DELAY_MS = 300;

export const UNCONFIRMED_TOOLTIP = 'Written; waiting for the disk to confirm';

/** A row of the Plugins tree: a plugin's, one of its record-type groups', or one of its records'. */
export type MarkedRow =
  | { plugin: PluginAddress }
  | { plugin: PluginAddress; recordType: string }
  | { plugin: PluginAddress; formKey: string };

/** What a write tells its marks once it is answered, or that it never was. */
export interface MarkAnswer<Answer> {
  answered(answer: Answer): void;
  unanswered(): void;
}

// `held` is what the record's holders show once the write lands. Where they cannot show it, it is
// undefined, and mEdit's report of the record is the disk's next value.
interface Pending {
  readonly row: MarkedRow;
  formKey: string | undefined;
  held: boolean | undefined;
  answer: 'awaited' | 'landed' | 'none';
  readonly unshown: (formKey: string) => string;
  marked: boolean;
  differedOnce: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

// An answer only confirms, since mEdit's index may not hold the write yet; a report of the record
// may differ once; a refresh is final.
type Read = 'answer' | 'report' | 'refresh';

const addressOf = (plugin: PluginAddress): string => pluginAddressKey(plugin.name, plugin.origin);

const rowKey = (row: MarkedRow): string =>
  [addressOf(row.plugin), 'recordType' in row ? row.recordType : '', 'formKey' in row ? row.formKey : ''].join('\n');

const sameRecord = (a: RecordAddress, b: RecordAddress): boolean =>
  a.formKey === b.formKey && pluginAddressKey(a.plugin, a.origin) === pluginAddressKey(b.plugin, b.origin);

const sameCopy = (a: CopyItem, b: CopyItem): boolean =>
  sameRecord(a.record, b.record) && addressOf(a.destination) === addressOf(b.destination);

/** The Plugins tree's rows a record create, copy or delete changed, each marked until mEdit's index
 *  shows the write (common.md, Unconfirmed writes). */
export class UnconfirmedRecordRows {
  private readonly pending = new Set<Pending>();

  constructor(private readonly deps: {
    client?: Pick<MEditClient, 'getRecordHolders'>;
    log: (line: string) => void;
    render: () => void;
  }) {}

  /** A new record is blank, so its line names it by FormKey alone. */
  creating(row: MarkedRow): MarkAnswer<string | undefined> {
    const pending = this.mark(row, undefined, true,
      (formKey) => `${formKey} was created in "${row.plugin.name}", and the disk does not hold it.`);
    return {
      answered: (formKey) => {
        if (formKey === undefined) this.drop(pending);
        else this.answered(pending, formKey);
      },
      unanswered: () => { this.unanswered(pending); },
    };
  }

  deleting(
    records: readonly RecordAddress[], editorIds: ReadonlyMap<string, string | undefined>,
  ): MarkAnswer<readonly RecordAddress[]> {
    const marks = records.map((record) => {
      const plugin = { name: record.plugin, origin: record.origin };
      return {
        record,
        pending: this.mark({ plugin, formKey: record.formKey }, record.formKey, false,
          (formKey) => `${recordName(formKey, editorIds)} was deleted from "${plugin.name}", and the disk still holds it.`),
      };
    });
    return {
      answered: (landed) => {
        for (const { record, pending } of marks) {
          if (landed.some((item) => sameRecord(item, record))) this.answered(pending, record.formKey);
          else this.drop(pending);
        }
      },
      unanswered: () => { for (const { pending } of marks) this.unanswered(pending); },
    };
  }

  /** A copy that replaces what its destination held leaves the destination holding the record, so
   *  only mEdit's report of it there settles the mark. */
  copying(
    items: readonly CopyItem[], mode: CopyMode, replacing: readonly CopyItem[], editorIds: ReadonlyMap<string, string | undefined>,
  ): MarkAnswer<readonly CopyItem[]> {
    const marks = items.map((item) => {
      const replaces = replacing.some((replaced) => sameCopy(replaced, item));
      return {
        item,
        pending: this.mark({ plugin: item.destination }, mode === 'Override' ? item.record.formKey : undefined, replaces ? undefined : true,
          () => `${recordName(item.record.formKey, editorIds)} was copied into "${item.destination.name}", and the disk does not hold the copy.`),
      };
    });
    return {
      answered: (landed) => {
        for (const { item, pending } of marks) {
          const copy = landed.find((written) => sameCopy(written, item));
          if (copy === undefined) this.drop(pending);
          else this.answered(pending, copy.newFormKey ?? item.record.formKey);
        }
      },
      unanswered: () => { for (const { pending } of marks) this.unanswered(pending); },
    };
  }

  /** mEdit's report that rows of `plugin` changed. */
  rowsChanged(plugin: PluginAddress, keys: readonly string[]): void {
    for (const pending of this.pending) {
      if (addressOf(pending.row.plugin) !== addressOf(plugin)) continue;
      const reported = pending.formKey === undefined ? pending.answer === 'none' : keys.includes(pending.formKey);
      if (!reported) continue;
      if (pending.held === undefined) this.drop(pending);
      else void this.settle(pending, 'report');
    }
  }

  /** A reconcile read every plugin again, as a refresh does. */
  reconciled(): void {
    for (const pending of this.pending) {
      if (pending.formKey === undefined || pending.held === undefined || pending.answer === 'none') this.drop(pending);
      else void this.settle(pending, 'refresh');
    }
  }

  isMarked(row: MarkedRow): boolean {
    const key = rowKey(row);
    return [...this.pending].some((pending) => pending.marked && rowKey(pending.row) === key);
  }

  dispose(): void {
    for (const pending of this.pending) clearTimeout(pending.timer);
    this.pending.clear();
  }

  private mark(row: MarkedRow, formKey: string | undefined, held: boolean | undefined, unshown: Pending['unshown']): Pending {
    const pending: Pending = {
      row, formKey, held, unshown, answer: 'awaited', marked: false, differedOnce: false,
      timer: setTimeout(() => {
        pending.marked = true;
        this.deps.render();
      }, MARK_DELAY_MS),
    };
    this.pending.add(pending);
    return pending;
  }

  private answered(pending: Pending, formKey: string): void {
    pending.answer = 'landed';
    pending.formKey = formKey;
    if (pending.held !== undefined) void this.settle(pending, 'answer');
  }

  // Only the disk can say what a write with no answer did (story 6); with no FormKey, nothing in
  // mEdit's report can be held against what was written.
  private unanswered(pending: Pending): void {
    pending.answer = 'none';
    if (pending.formKey === undefined) pending.held = undefined;
  }

  private drop(pending: Pending): void {
    clearTimeout(pending.timer);
    if (this.pending.delete(pending) && pending.marked) this.deps.render();
  }

  // A read that fails keeps the mark, as a disk that cannot be read does (States, story 6).
  private async settle(pending: Pending, read: Read): Promise<void> {
    const { formKey, held } = pending;
    if (formKey === undefined || held === undefined || !this.deps.client) return;
    let holders: PluginAddress[];
    try {
      holders = await this.deps.client.getRecordHolders(formKey);
    } catch {
      return;
    }
    if (!this.pending.has(pending)) return;
    if (holders.some((holder) => addressOf(holder) === addressOf(pending.row.plugin)) !== held) {
      if (read === 'answer') return;
      if (read === 'report' && !pending.differedOnce) {
        pending.differedOnce = true;
        return;
      }
      this.deps.log(pending.unshown(formKey));
    }
    this.drop(pending);
  }
}

// As the record panel names a record: its EditorID with the FormKey, or the FormKey alone.
function recordName(formKey: string, editorIds: ReadonlyMap<string, string | undefined>): string {
  const editorId = editorIds.get(formKey);
  return editorId ? `${editorId} [${formKey}]` : formKey;
}
