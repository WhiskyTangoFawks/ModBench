import type { components } from './generated/api';
import type {
  ApiClient, PluginMetadata, LoadOrderStatus, TrackStatus,
  WorldspaceSummary, CellReferences, WorldspaceBlocks,
  UnansweredExternalChange, ContainerChildSummary,
} from './ApiClient';
import { errorText } from './ApiClient';

/**
 * What one field edit came to. A refusal is a first-class outcome here, not an exception —
 * `refusal` is the backend's RecordEditRefusal name, which is what lets the caller act differently
 * for an untracked mod (offer Track) than for a base-game master (name the patch-plugin path).
 */
export type RecordFieldEditOutcome =
  | { applied: true }
  | { applied: false; refusal: string; message: string };

export type PluginRecordTypeCount = components['schemas']['PluginRecordTypeCount'];
export type RecordPage = components['schemas']['RecordSummaryPagedResult'];
export type CellPage = components['schemas']['CellSummaryPagedResult'];

// The `?? []` / `?? { items: [], total: 0 }` defaults on `data` below are about *transport*, not
// about the wire shape: openapi-fetch types `data` as `T | undefined` because a non-ok response
// carries `error` instead, and TypeScript cannot see that `ensureOk` already threw. They are not
// the per-field nullability compensation this file used to carry (#627) — that is gone, and the
// generated types are now trusted field-for-field.

export interface PluginRepository {
  getPlugins(): Promise<PluginMetadata[]>;
  // ADR-0035: the reconcile's own progress, polled alongside the in-flight PUT. Separate
  // from getPlugins() rather than folded into it: this one answers while the load order is still
  // incomplete, and it is the only read that can distinguish "not looked yet" from "no conflict".
  getLoadOrderStatus(): Promise<LoadOrderStatus>;
  // The Track gesture's own progress, polled alongside the in-flight track POST —
  // same idiom as getLoadOrderStatus above.
  getTrackStatus(): Promise<TrackStatus>;
  // Every plugin currently holding an unanswered external-change question — polled the same
  // way, no load-order dependency of its own (the queue lives on the backend's singleton watcher).
  getExternalChangeStatus(): Promise<UnansweredExternalChange[]>;
  // origin (ADR-0036): which copy of `plugin` to read, when the load order holds two files of
  // one filename. Optional — an ordinary load-order row has no origin to give, and the backend
  // resolves that case from the load order, where a filename is unambiguous.
  getRecordTypes(plugin: string, origin?: string): Promise<PluginRecordTypeCount[]>;
  getRecords(plugin: string, type: string, offset: number, limit: number, origin?: string): Promise<RecordPage>;
  // The FormKey picker's own search — free-text `query` matched against EditorID or
  // a FormKey-shaped string, scoped to `validTypes` only when there's exactly one
  // (an unscoped/multi-type field searches across every record type). Capped at 20 results.
  searchRecords(query: string, validTypes: string[]): Promise<RecordPage>;
  // Which plugin (+ origin) a FormKey's *winning* override belongs to — the record
  // editor's Save & Compile icon resolves its active record's owning plugin through this, rather
  // than falling through to an unfiltered QuickPick that can compile the wrong plugin in a
  // multi-mod load order. undefined for an unknown FormKey (404) — never thrown, since "the actively
  // open record just isn't resolvable" is the caller's own fallback path, not a failure to report.
  getRecordOwner(formKey: string): Promise<{ plugin: string; origin: string } | undefined>;
  // The Copy as Override destination picker's own exclusion data — every plugin already
  // holding an override (or the native/winning copy) of this FormKey, straight off GET
  // /records/{formKey}/compare's existing Overrides list; no dedicated endpoint needed. Empty for
  // an unknown FormKey (404), the same "not a fault" posture getRecordOwner's own 404 case uses.
  getRecordOverridePlugins(formKey: string): Promise<string[]>;
  // The Renumber gesture's FormID input box's suggested default — the same both-refs
  // allocator create/renumber use internally, exposed read-only (xEdit's own "New FormID
  // generated" flow). Never throws on the ordinary case; a genuine fault propagates like every
  // other read here.
  peekNextFreeFormKey(plugin: string, origin: string): Promise<string>;
  // The condition-function picker's catalog — every function name Mutagen resolves
  // for the held load order's game, backing the extension-host QuickPick. Degrades to [] on a
  // failed fetch (mirrors setFilter/clearFilter's catch-and-log-no-throw below, not the
  // ensureOk-then-throw convention most reads here use) — a failed catalogue fetch must never
  // surface as a raw error.
  getConditionFunctions(): Promise<string[]>;
  setFilter(sql: string): Promise<string | null>; // returns error message or null on success
  clearFilter(): Promise<void>;
  getActiveFilter(): Promise<string | null>;

  // Per-plugin worldspace tree. origin (ADR-0036): same optional shape as
  // getRecordTypes/getRecords above — a row that stands for a specific copy states it.
  /**
   * ADR-0041: one field edit through the single write path. Never throws on a refusal — a
   * refused edit is an ordinary, expected answer (the plugin is untracked, the link would dangle),
   * not a failure to report as one, so it comes back as a typed result the caller surfaces. Only a
   * genuine transport failure rejects.
   */
  editRecordField(
    formKey: string, plugin: string, origin: string, fieldPath: string, value: unknown,
  ): Promise<RecordFieldEditOutcome>;

  getWorldspaces(plugin: string, origin?: string): Promise<WorldspaceSummary[]>;
  getWorldspaceBlocks(plugin: string, worldspaceFormKey: string, origin?: string): Promise<WorldspaceBlocks>;
  getCellReferences(plugin: string, cellFormKey: string, origin?: string): Promise<CellReferences>;
  getInteriorCells(plugin: string, offset: number, limit: number, origin?: string): Promise<CellPage>;
  // A container record's own children (a Quest's dialog topics/branches/scenes, a Dialog
  // Topic's responses), in xEdit's own presentation order — same optional-origin shape as the
  // worldspace-tree reads above. Cells/worldspaces are unaffected: this reads Quest/DialogTopic
  // containment only, never Cell.NavigationMeshes/Landscape or Worldspace.TopCell/SubCells.
  getContainerChildren(plugin: string, parentFormKey: string, origin?: string): Promise<ContainerChildSummary[]>;
}

// ADR-0026: how long a tree-populating fetch (see `withTimeout` below) is given before it
// is treated as hung rather than merely slow. No existing convention to anchor this to (checked
// ADR-0026 and docs/specs/plugins.md) — 30s is a generous, ordinary HTTP-client default.
// Deliberately not trying to distinguish "still working" from "actually stuck": a
// slow-but-eventually-resolving call and a genuinely hung one look the same to the tree,
// which has no way to tell them apart. Constructor-overridable so a test can inject a tiny
// value instead of faking timers.
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

  // Don't swallow read failures into []/empty: a 503 "No load order has been received", a 500,
  // or a network error must reach the tree so it renders an ErrorNode rather than
  // a silent empty list indistinguishable from genuinely empty data (ADR-0026).
  // A 200 with an empty/absent body is a legitimate empty result.
  // Genuine network-level throws propagate as-is. Mirrors the getPlugins convention.
  private ensureOk(what: string, response: Response, error?: unknown): void {
    if (response.ok) return;
    const text = errorText(error);
    const detail = text ? `: ${text}` : '';
    const msg = `${what} failed (${response.status})${detail}`;
    this.log(`[PluginRepository] ${msg}`);
    throw new Error(msg);
  }

  // Races `fn` (handed its own single-use AbortSignal) against a timeoutMs deadline, rather
  // than trusting the underlying fetch to honor that signal on its own — a hung backend and a
  // non-cooperative test double behave identically either way, and racing is what makes both
  // still cause the returned promise to settle. `fn`'s own signal is aborted on timeout too, so a
  // fetch implementation that *does* honor it (the real one, via undici) gets genuine
  // cancellation of the in-flight request, not just a client-side rejection.
  // Reuses `what` as the timeout message's own label,
  // matching ensureOk's failure-message vocabulary so the two read as the same family of error.
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

  // The endpoint answers 200 in every state including "no load order" (LoadOrderEndpoints.cs),
  // so a non-ok is a genuine fault and gets the same ensureOk treatment as every other read here.
  // Degrading it to an empty status would be indistinguishable from a reconcile making no progress.
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

  async getRecordTypes(plugin: string, origin?: string): Promise<{ type: string; count: number; displayName: string }[]> {
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

  async getConditionFunctions(): Promise<string[]> {
    try {
      const { data, response } = await this.client.GET('/condition-functions', {});
      if (!response.ok) {
        this.log(`[PluginRepository] getConditionFunctions failed (${response.status})`);
        return [];
      }
      return data ?? [];
    } catch (e) {
      this.log(`[PluginRepository] getConditionFunctions failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
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

    // The backend's own typed discriminator, read off the ProblemDetails extension rather than
    // re-derived from the status code — the status says what *kind* of problem it is, this says
    // which one, and only the latter can tell "not tracked" from "no mod folder", whose ways out
    // differ (ADR-0026).
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
