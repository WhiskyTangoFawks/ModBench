import type { components } from './generated/api';
import type {
  ApiClient, PluginMetadata, LoadOrderStatus, TrackStatus,
  WorldspaceSummary, CellReferences, WorldspaceBlocks,
  UnansweredExternalChange, ContainerChildSummary, PluginDiagnosisReport,
} from './ApiClient';
import { errorText, isWriteGateTimeout, writeGateBusyMessage } from './ApiClient';

/** A refusal is an outcome, not an exception: `refusal` carries the backend's own name for it,
 *  which lets a caller offer Track for one and the patch-plugin path for another. `'Unknown'`
 *  and `'WriteGateBusy'` are this side's additions. */
export type RecordFieldEditOutcome =
  | { applied: true }
  | { applied: false; refusal: string; message: string };

export type PluginRecordTypeCount = components['schemas']['PluginRecordTypeCount'];
export type RecordPage = components['schemas']['RecordSummaryPagedResult'];
export type CellPage = components['schemas']['CellSummaryPagedResult'];

// The `?? []` / `?? { items: [], total: 0 }` defaults below are about *transport*, not the wire
// shape: openapi-fetch types `data` as `T | undefined` because a non-ok response carries `error`
// instead, and TypeScript cannot see that `ensureOk` already threw.

export interface PluginRepository {
  getPlugins(): Promise<PluginMetadata[]>;
  /** Read off each held plugin's original bytes and worded exactly as the Track refusal words
   *  them — one vocabulary. One call for the whole load order. */
  getDiagnoses(): Promise<PluginDiagnosisReport[]>;
  // ADR-0035: separate from getPlugins() because this one answers while the load order is still
  // incomplete, and it alone distinguishes "not looked yet" from "no conflict".
  getLoadOrderStatus(): Promise<LoadOrderStatus>;
  // Polled alongside the in-flight track POST.
  getTrackStatus(): Promise<TrackStatus>;
  // No load-order dependency of its own: the queue lives on the backend's singleton watcher.
  getExternalChangeStatus(): Promise<UnansweredExternalChange[]>;
  // origin (ADR-0036) says which copy of `plugin` to read when two files share a filename.
  // Optional: a plain load-order row has none to give, and the backend resolves that case itself.
  getRecordTypes(plugin: string, origin?: string): Promise<PluginRecordTypeCount[]>;
  getRecords(plugin: string, type: string, offset: number, limit: number, origin?: string): Promise<RecordPage>;
  // `query` matches an EditorID or a FormKey-shaped string. Scoped to `validTypes` only when
  // there is exactly one; a multi-type field searches every record type. Capped at 20 results.
  searchRecords(query: string, validTypes: string[]): Promise<RecordPage>;
  // The *winning* override's plugin. undefined for an unknown FormKey (404), never thrown: an
  // unresolvable open record is the caller's fallback path, not a failure to report.
  getRecordOwner(formKey: string): Promise<{ plugin: string; origin: string } | undefined>;
  // Read off the existing compare endpoint's Overrides list; no dedicated endpoint needed.
  // Empty for an unknown FormKey (404), the same "not a fault" posture as getRecordOwner.
  getRecordOverridePlugins(formKey: string): Promise<string[]>;
  // The allocator create and renumber use internally, exposed read-only — xEdit's own
  // "New FormID generated" flow.
  peekNextFreeFormKey(plugin: string, origin: string): Promise<string>;
  /** The renumber confirmation's blast radius. */
  getReferences(formKey: string): Promise<components['schemas']['ReferenceResult'][]>;
  setFilter(sql: string): Promise<string | null>; // returns error message or null on success
  clearFilter(): Promise<void>;
  getActiveFilter(): Promise<string | null>;

  /** ADR-0041: the single write path. A refusal (untracked plugin, a link that would dangle) is
   *  an expected answer and comes back typed; only a transport failure rejects. */
  editRecordField(
    formKey: string, plugin: string, origin: string, fieldPath: string, value: unknown,
  ): Promise<RecordFieldEditOutcome>;

  getWorldspaces(plugin: string, origin?: string): Promise<WorldspaceSummary[]>;
  getWorldspaceBlocks(plugin: string, worldspaceFormKey: string, origin?: string): Promise<WorldspaceBlocks>;
  getCellReferences(plugin: string, cellFormKey: string, origin?: string): Promise<CellReferences>;
  getInteriorCells(plugin: string, offset: number, limit: number, origin?: string): Promise<CellPage>;
  // Quest and DialogTopic containment only, in xEdit's presentation order — never
  // Cell.NavigationMeshes/Landscape or Worldspace.TopCell/SubCells.
  getContainerChildren(plugin: string, parentFormKey: string, origin?: string): Promise<ContainerChildSummary[]>;
}

// No convention in ADR-0026 or docs/specs/plugins.md anchors this: 30s is an ordinary
// HTTP-client default. A slow call and a hung one look the same to the tree, so nothing tries to
// tell them apart.
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export class ApiPluginRepository implements PluginRepository {
  private readonly log: (msg: string) => void;

  constructor(
    private readonly client: ApiClient,
    log?: (msg: string) => void,
    private readonly timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  ) {
    this.log = log ?? (() => {});
  }

  // Never swallow a read failure into an empty list: it would be indistinguishable from
  // genuinely empty data, so the tree could not render an ErrorNode (ADR-0026). A 200 with an
  // absent body is a legitimate empty result.
  private ensureOk(what: string, response: Response, error?: unknown): void {
    if (response.ok) return;
    const text = errorText(error);
    const detail = text ? `: ${text}` : '';
    const msg = `${what} failed (${response.status})${detail}`;
    this.log(`[PluginRepository] ${msg}`);
    throw new Error(msg);
  }

  // Races rather than trusting the fetch to honor the signal: a hung backend and an
  // uncooperative test double both still settle the promise. The signal is aborted anyway, so a
  // fetch that honors it cancels for real.
  private async withTimeout<T>(what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${what} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([fn(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async getPlugins(): Promise<PluginMetadata[]> {
    const { data, error, response } = await this.client.GET('/plugins', {});
    this.ensureOk('GET /plugins', response, error);
    return data ?? [];
  }

  async getDiagnoses(): Promise<PluginDiagnosisReport[]> {
    const { data, error, response } = await this.client.GET('/plugins/diagnoses', {});
    this.ensureOk('GET /plugins/diagnoses', response, error);
    return data ?? [];
  }

  // The endpoint answers 200 in every state, "no load order" included, so a non-ok is a genuine
  // fault: an empty status would be indistinguishable from a reconcile making no progress.
  async getLoadOrderStatus(): Promise<LoadOrderStatus> {
    const { data, error, response } = await this.client.GET('/load-order/status', {});
    this.ensureOk('GET /load-order/status', response, error);
    return {
      totalPlugins: data?.totalPlugins ?? 0,
      // The wire carries each entry's origin too; the consumer keys on filename alone (see
      // LoadOrderStatus in ApiClient.ts), so it is dropped here rather than carried unused.
      indexedPlugins: (data?.indexedPlugins ?? []).map((p) => p.name),
      conflictsComputed: data?.conflictsComputed ?? false,
      failures: data?.failures ?? [],
    };
  }

  // Same "always 200, never degrade a fault into a fake idle" posture as
  // getLoadOrderStatus above.
  async getTrackStatus(): Promise<TrackStatus> {
    const { data, error, response } = await this.client.GET('/plugins/track/status', {});
    this.ensureOk('GET /plugins/track/status', response, error);
    return data ?? { phase: 'Idle', pluginsDone: 0, pluginsTotal: 0 };
  }

  // Same "always 200, never degrade a fault into a fake empty queue" posture as
  // getLoadOrderStatus/getTrackStatus above.
  async getExternalChangeStatus(): Promise<UnansweredExternalChange[]> {
    const { data, error, response } = await this.client.GET('/plugins/external-changes/status', {});
    this.ensureOk('GET /plugins/external-changes/status', response, error);
    return data ?? [];
  }

  async getRecordTypes(plugin: string, origin?: string): Promise<PluginRecordTypeCount[]> {
    return this.withTimeout(`getRecordTypes(${plugin})`, async (signal) => {
      const { data, error, response } = await this.client.GET('/plugins/{plugin}/record-types', {
        params: { path: { plugin }, query: origin === undefined ? {} : { origin } },
        signal,
      });
      this.ensureOk(`getRecordTypes(${plugin})`, response, error);
      return data ?? [];
    });
  }

  async getRecords(plugin: string, type: string, offset: number, limit: number, origin?: string): Promise<RecordPage> {
    return this.withTimeout(`getRecords(${plugin}, ${type})`, async (signal) => {
      const { data, error, response } = await this.client.GET('/records', {
        params: { query: { plugin, type, offset, limit, ...(origin === undefined ? {} : { origin }) } },
        signal,
      });
      this.ensureOk(`getRecords(${plugin}, ${type})`, response, error);
      return data ?? { items: [], total: 0 };
    });
  }

  async searchRecords(query: string, validTypes: string[]): Promise<RecordPage> {
    const { data, error, response } = await this.client.GET('/records', {
      params: {
        query: {
          search: query,
          ...(validTypes.length === 1 ? { type: validTypes[0] } : {}),
          limit: 20,
        },
      },
    });
    this.ensureOk(`searchRecords(${query})`, response, error);
    return data ?? { items: [], total: 0 };
  }

  async getRecordOwner(formKey: string): Promise<{ plugin: string; origin: string } | undefined> {
    const { data, error, response } = await this.client.GET('/records/{formKey}', { params: { path: { formKey } } });
    if (response.status === 404) return undefined;
    this.ensureOk(`getRecordOwner(${formKey})`, response, error);
    return data ? { plugin: data.plugin, origin: data.origin } : undefined;
  }

  // See the interface's own doc comment — a 404 (unknown FormKey) is "nothing carries it
  // yet", not a fault, same posture as getRecordOwner's own 404 case above.
  async getRecordOverridePlugins(formKey: string): Promise<string[]> {
    const { data, error, response } = await this.client.GET('/records/{formKey}/compare', {
      params: { path: { formKey } },
    });
    if (response.status === 404) return [];
    this.ensureOk(`getRecordOverridePlugins(${formKey})`, response, error);
    return (data?.overrides ?? []).map((o) => o.plugin);
  }

  async peekNextFreeFormKey(plugin: string, origin: string): Promise<string> {
    const { data, error, response } = await this.client.GET('/plugins/{plugin}/records/next-form-key', {
      params: { path: { plugin }, query: { origin } },
    });
    this.ensureOk(`peekNextFreeFormKey(${plugin})`, response, error);
    return data?.formKey ?? '';
  }

  async getReferences(formKey: string): Promise<components['schemas']['ReferenceResult'][]> {
    const { data, error, response } = await this.client.GET('/records/{formKey}/references', {
      params: { path: { formKey } },
    });
    this.ensureOk(`getReferences(${formKey})`, response, error);
    return data ?? [];
  }

  async setFilter(sql: string): Promise<string | null> {
    try {
      const { error, response } = await this.client.POST('/load-order/filter', { body: { sql } });
      if (!response.ok) {
        const text = errorText(error);
        this.log(`[PluginRepository] setFilter failed (${response.status}): ${text}`);
        return text;
      }
      return null;
    } catch (e) {
      this.log(`[PluginRepository] setFilter failed: ${e instanceof Error ? e.message : String(e)}`);
      return e instanceof Error ? e.message : String(e);
    }
  }

  async clearFilter(): Promise<void> {
    try {
      const { error, response } = await this.client.DELETE('/load-order/filter', {});
      if (!response.ok) {
        const text = errorText(error);
        this.log(`[PluginRepository] clearFilter failed (${response.status}): ${text}`);
      }
    } catch (e) {
      this.log(`[PluginRepository] clearFilter failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async getActiveFilter(): Promise<string | null> {
    const { data, error, response } = await this.client.GET('/load-order/filter', {});
    this.ensureOk('getActiveFilter', response, error);
    return data?.sql ?? null;
  }

  async editRecordField(
    formKey: string, plugin: string, origin: string, fieldPath: string, value: unknown,
  ): Promise<RecordFieldEditOutcome> {
    const { data, error, response } = await this.client.POST('/records/{formKey}/field', {
      params: { path: { formKey } },
      body: { plugin, origin, fieldPath, value },
    });
    if (response.ok && data?.applied) return { applied: true };

    // The one gate-wrapped write that does not reach the user through `EditingController.mutate`,
    // so the busy branch is stated here too, before the refusal shaping below would relay the
    // gate's prose as a judgement on this edit.
    if (isWriteGateTimeout(error)) {
      const message = writeGateBusyMessage('Could not edit this record');
      this.log(`[PluginRepository] editRecordField(${formKey}.${fieldPath}) hit the write gate (${response.status})`);
      return { applied: false, refusal: 'WriteGateBusy', message };
    }

    // The backend's typed discriminator, off the ProblemDetails extension rather than re-derived
    // from the status: only it tells "not tracked" from "no folder", whose ways out differ.
    const problem = error as { refusal?: string; detail?: string } | undefined;
    const outcome: RecordFieldEditOutcome = {
      applied: false,
      refusal: problem?.refusal ?? 'Unknown',
      message: problem?.detail ?? errorText(error) ?? `Edit failed (${response.status}).`,
    };
    this.log(`[PluginRepository] editRecordField(${formKey}.${fieldPath}) refused: ${outcome.refusal} — ${outcome.message}`);
    return outcome;
  }

  async getWorldspaces(plugin: string, origin?: string): Promise<WorldspaceSummary[]> {
    return this.withTimeout(`getWorldspaces(${plugin})`, async (signal) => {
      const { data, error, response } = await this.client.GET('/plugins/{plugin}/worldspaces', {
        params: { path: { plugin }, query: origin === undefined ? {} : { origin } },
        signal,
      });
      this.ensureOk(`getWorldspaces(${plugin})`, response, error);
      return data ?? [];
    });
  }

  async getWorldspaceBlocks(plugin: string, worldspaceFormKey: string, origin?: string): Promise<WorldspaceBlocks> {
    return this.withTimeout(`getWorldspaceBlocks(${plugin}, ${worldspaceFormKey})`, async (signal) => {
      const { data, error, response } = await this.client.GET('/plugins/{plugin}/worldspaces/{formKey}/blocks', {
        params: { path: { plugin, formKey: worldspaceFormKey }, query: origin === undefined ? {} : { origin } },
        signal,
      });
      this.ensureOk(`getWorldspaceBlocks(${plugin}, ${worldspaceFormKey})`, response, error);
      return data ?? { topCells: [], blocks: [] };
    });
  }

  async getCellReferences(plugin: string, cellFormKey: string, origin?: string): Promise<CellReferences> {
    return this.withTimeout(`getCellReferences(${plugin}, ${cellFormKey})`, async (signal) => {
      const { data, error, response } = await this.client.GET('/plugins/{plugin}/cells/{formKey}/references', {
        params: { path: { plugin, formKey: cellFormKey }, query: origin === undefined ? {} : { origin } },
        signal,
      });
      this.ensureOk(`getCellReferences(${plugin}, ${cellFormKey})`, response, error);
      return data ?? { persistent: [], temporary: [] };
    });
  }

  async getInteriorCells(plugin: string, offset: number, limit: number, origin?: string): Promise<CellPage> {
    return this.withTimeout(`getInteriorCells(${plugin})`, async (signal) => {
      const { data, error, response } = await this.client.GET('/plugins/{plugin}/interior-cells', {
        params: { path: { plugin }, query: { offset, limit, ...(origin === undefined ? {} : { origin }) } },
        signal,
      });
      this.ensureOk(`getInteriorCells(${plugin})`, response, error);
      return data ?? { items: [], total: 0 };
    });
  }

  async getContainerChildren(plugin: string, parentFormKey: string, origin?: string): Promise<ContainerChildSummary[]> {
    return this.withTimeout(`getContainerChildren(${plugin}, ${parentFormKey})`, async (signal) => {
      const { data, error, response } = await this.client.GET('/plugins/{plugin}/records/{formKey}/children', {
        params: { path: { plugin, formKey: parentFormKey }, query: origin === undefined ? {} : { origin } },
        signal,
      });
      this.ensureOk(`getContainerChildren(${plugin}, ${parentFormKey})`, response, error);
      return data ?? [];
    });
  }

}
