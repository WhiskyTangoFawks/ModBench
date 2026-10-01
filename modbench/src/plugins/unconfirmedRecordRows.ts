import type { CopyItem, MEditClient, PluginAddress, RecordAddress } from '../client';
import { pluginAddressKey } from './trackedRepositories';

export const MARK_DELAY_MS = 300;

export const UNCONFIRMED_TOOLTIP = 'Written; waiting for the disk to confirm';

/** A row of the Plugins tree: a plugin's, one of its record-type groups', or one of its records'. */
export interface MarkedRow {
  plugin: PluginAddress;
  recordType?: string;
  formKey?: string;
}

/** One copy a copy wrote: a new record's FormKey is the one mEdit minted for it. */
export type CopyWritten = CopyItem & { newFormKey?: string | null };

// A write is unconfirmed until mEdit's index shows `formKey` held by `plugin`, or not held by it.
interface Pending {
  readonly row: MarkedRow;
  readonly plugin: PluginAddress;
  readonly held: boolean;
  formKey: string | undefined;
  readonly unshown: (formKey: string) => string;
  marked: boolean;
  differedOnce: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

// An answer only confirms, since mEdit's index may not hold the write yet; a report of the record
// may differ once; a refresh is final.
type Read = 'answer' | 'report' | 'refresh';

const addressOf = (plugin: PluginAddress): string => pluginAddressKey(plugin.name, plugin.origin);

const rowKey = ({ plugin, recordType, formKey }: MarkedRow): string =>
  [addressOf(plugin), recordType ?? '', formKey ?? ''].join('\n');

const sameCopy = (a: CopyItem, b: CopyItem): boolean => a.record.formKey === b.record.formKey
  && pluginAddressKey(a.record.plugin, a.record.origin) === pluginAddressKey(b.record.plugin, b.record.origin)
  && addressOf(a.destination) === addressOf(b.destination);

/** The Plugins tree's rows a record create, copy or delete changed, each marked until mEdit's index
 *  shows the write (common.md, Unconfirmed writes). What a mark returns is told what landed, and
 *  forgets the rest. */
export class UnconfirmedRecordRows {
  private readonly pending = new Set<Pending>();

  constructor(private readonly deps: {
    client?: Pick<MEditClient, 'getRecordHolders'>;
    log: (line: string) => void;
    render: () => void;
  }) {}

  creating(row: MarkedRow): (formKey: string | undefined) => void {
    const pending = this.mark(row, row.plugin, true, undefined,
      (formKey) => `${formKey} was created in "${row.plugin.name}", and the disk does not hold it.`);
    return (formKey) => {
      if (formKey === undefined) this.drop(pending);
      else this.answered(pending, formKey);
    };
  }

  deleting(records: readonly RecordAddress[]): (landed: readonly RecordAddress[]) => void {
    const marks = records.map((record) => {
      const plugin = { name: record.plugin, origin: record.origin };
      return this.mark({ plugin, formKey: record.formKey }, plugin, false, record.formKey,
        (formKey) => `${formKey} was deleted from "${plugin.name}", and the disk still holds it.`);
    });
    return (landed) => {
      const kept = new Set(landed.map((r) => rowKey({ plugin: { name: r.plugin, origin: r.origin }, formKey: r.formKey })));
      for (const pending of marks) {
        if (kept.has(rowKey(pending.row))) void this.settle(pending, 'answer');
        else this.drop(pending);
      }
    };
  }

  copying(items: readonly CopyItem[]): (landed: readonly CopyWritten[]) => void {
    const marks = items.map((item) => ({
      item,
      pending: this.mark({ plugin: item.destination }, item.destination, true, undefined,
        (formKey) => `${formKey} was copied into "${item.destination.name}", and the disk does not hold the copy.`),
    }));
    return (landed) => {
      for (const { item, pending } of marks) {
        const copy = landed.find((written) => sameCopy(written, item));
        if (copy === undefined) this.drop(pending);
        else this.answered(pending, copy.newFormKey ?? item.record.formKey);
      }
    };
  }

  /** mEdit's report that rows of `plugin` changed. */
  rowsChanged(plugin: PluginAddress, keys: readonly string[]): void {
    for (const pending of this.pending) {
      if (pending.formKey !== undefined && keys.includes(pending.formKey) && addressOf(pending.plugin) === addressOf(plugin)) {
        void this.settle(pending, 'report');
      }
    }
  }

  /** A reconcile read every plugin again, as a refresh does. */
  reconciled(): void {
    for (const pending of this.pending) void this.settle(pending, 'refresh');
  }

  isMarked(row: MarkedRow): boolean {
    const key = rowKey(row);
    return [...this.pending].some((pending) => pending.marked && rowKey(pending.row) === key);
  }

  dispose(): void {
    for (const pending of this.pending) clearTimeout(pending.timer);
    this.pending.clear();
  }

  private mark(
    row: MarkedRow, plugin: PluginAddress, held: boolean, formKey: string | undefined, unshown: Pending['unshown'],
  ): Pending {
    const pending: Pending = {
      row, plugin, held, formKey, unshown, marked: false, differedOnce: false,
      timer: setTimeout(() => {
        pending.marked = true;
        this.deps.render();
      }, MARK_DELAY_MS),
    };
    this.pending.add(pending);
    return pending;
  }

  private answered(pending: Pending, formKey: string): void {
    pending.formKey = formKey;
    void this.settle(pending, 'answer');
  }

  private drop(pending: Pending): void {
    clearTimeout(pending.timer);
    if (this.pending.delete(pending) && pending.marked) this.deps.render();
  }

  // A read that fails keeps the mark, as a disk that cannot be read does (States, story 6).
  private async settle(pending: Pending, read: Read): Promise<void> {
    const { formKey } = pending;
    if (formKey === undefined || !this.deps.client) return;
    let holders: PluginAddress[];
    try {
      holders = await this.deps.client.getRecordHolders(formKey);
    } catch {
      return;
    }
    if (!this.pending.has(pending)) return;
    if (holders.some((holder) => addressOf(holder) === addressOf(pending.plugin)) !== pending.held) {
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
