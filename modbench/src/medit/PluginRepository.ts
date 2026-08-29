import type { components } from './generated/api';
import type {
  ApiClient, PluginMetadata, MasterIssue, RecordSummary, SessionStatus, TrackStatus, TrackPhase,
  WorldspaceSummary, CellSummary, CellReferences, PlacedSummary, WorldspaceBlocks,
  PendingExternalChange, WorkingTreeState, ConflictingRecord, ContainerChildSummary, PluginDeltaEntry,
} from './ApiClient';
import { errorText } from './ApiClient';

/**
 * #415: what one field edit came to. A refusal is a first-class outcome here, not an exception —
 * `refusal` is the backend's RecordEditRefusal name, which is what lets the caller act differently
 * for an untracked mod (offer Track) than for a base-game master (name the patch-plugin path).
 */
export type RecordFieldEditOutcome =
  | { applied: true }
  | { applied: false; refusal: string; message: string };

type PluginResponse = components['schemas']['PluginResponse'];
type GeneratedMasterIssue = components['schemas']['MasterIssue'];
type GeneratedRecordSummary = components['schemas']['RecordSummary'];
type GeneratedConflictRecord = components['schemas']['ConflictRecord'];
type PluginRecordTypeCount = components['schemas']['PluginRecordTypeCount'];
type GeneratedPluginDeltaEntry = components['schemas']['PluginDeltaEntry'];
function toMasterIssue(i: GeneratedMasterIssue): MasterIssue {
  return { masterName: i.masterName ?? '', kind: i.kind ?? 'DirectlyMissing' };
}

// #544: PluginDeltaPresence is JsonStringEnumConverter'd at its own declaration (mirroring
// ConflictAll's own attribute), so — unlike toTrackPhase's numeric-enum workaround above — the
// generator already produces the string-literal union type here; trust the wire string.
function toPluginDeltaEntry(e: GeneratedPluginDeltaEntry): PluginDeltaEntry {
  return { formKey: e.formKey ?? '', editorId: e.editorId ?? null, presence: e.presence ?? 'BothDiffer' };
}

// #414 review F2: the generated TrackPhase type is a numeric union (0|1|2|3) — Swashbuckle's
// schema generation doesn't pick up the global JsonStringEnumConverter for every enum (SessionState
// above has the identical, already-accepted mismatch), but the wire bytes are the real string
// values ("Idle", "Parsing", ...), confirmed against the live endpoint. Cast through `unknown`
// rather than trust the generated numeric type, same avoidance this file already gives origin/
// masterIssues optionality elsewhere.
function toTrackPhase(phase: unknown): TrackPhase {
  return typeof phase === 'string' ? (phase as TrackPhase) : 'Idle';
}

// #275 / ADR-0036: the backend always populates PluginResponse.Origin with a real, non-empty
// value — the generated type still shows `origin?: string | null` only because this backend's
// OpenAPI schema generator isn't NRT-aware for any property (#297), not because origin is ever
// actually optional on the wire. Fabricating a fallback (the reserved Data-directory value some
// previous code used) would silently mislabel a real backend regression as "this plugin came
// from the Data directory" — exactly the silent-wrong-state class of bug this epic exists to
// stop (ADR-0026). Fail loudly instead.
function requireOrigin(r: PluginResponse): string {
  if (!r.origin) throw new Error(`mEdit: backend returned a plugin without an origin (${r.name ?? '<unknown>'})`);
  return r.origin;
}

// #278 / ADR-0035 amending ADR-0018: the backend has always emitted this since
// RecordQueryService gained it, but the generated type is `boolean | undefined` for the same
// reason origin is `string | undefined | null` above (#297) — the OpenAPI generator isn't
// NRT-aware. `?? true` degrades to "matches" rather than "doesn't", the safe direction: it never
// suppresses a chevron a stale/older backend never meant to suppress. Its own function (rather
// than inline in toPluginMetadata) keeps that one under its complexity budget.
function hasMatchingRecords(r: PluginResponse): boolean {
  return r.hasMatchingRecords ?? true;
}

// #449: the generated type is `boolean | undefined`/`string | null | undefined` for the same
// NRT-unawareness (#297) every other optional-looking field on this wire shape already degrades
// around — a backend predating this field reports "not pending", never a stale true. Its own
// function, same reason hasMatchingRecords above is one: keeps toPluginMetadata under its
// complexity budget.
function compileFreshnessOf(r: PluginResponse): { compilePending: boolean; lastCompiledAt: string | null } {
  return { compilePending: r.compilePending ?? false, lastCompiledAt: r.lastCompiledAt ?? null };
}

function toPluginMetadata(r: PluginResponse): PluginMetadata {
  return {
    name: r.name ?? '',
    path: r.path ?? '',
    loadOrderIndex: r.loadOrderIndex ?? 0,
    isLight: r.isLight ?? false,
    isMaster: r.isMaster ?? false,
    masters: r.masters ?? [],
    recordCount: r.recordCount ?? 0,
    isImmutable: r.isImmutable ?? false,
    origin: requireOrigin(r),
    masterIssues: (r.masterIssues ?? []).map(toMasterIssue),
    hasMatchingRecords: hasMatchingRecords(r),
    ...compileFreshnessOf(r),
  };
}

// #428: the generated WorkingTreeState is numeric (0|1|2) for the same reason toTrackPhase's own
// comment already gives — Swashbuckle isn't JsonStringEnumConverter-aware — but Program.cs
// registers that converter globally, so the real wire value is the string. Trust the string.
function toWorkingTreeState(state: unknown): WorkingTreeState {
  return typeof state === 'string' ? (state as WorkingTreeState) : 'None';
}

function toRecordSummary(r: GeneratedRecordSummary): RecordSummary {
  return {
    formKey: r.formKey ?? '',
    plugin: r.plugin ?? '',
    loadOrderIndex: r.loadOrderIndex ?? 0,
    isWinner: r.isWinner ?? false,
    editorId: r.editorId ?? null,
    workingTreeState: toWorkingTreeState(r.workingTreeState),
  };
}

// #364: same "generated enum is a plain union, trust the wire string" posture as
// toWorkingTreeState — ConflictAll is JsonStringEnumConverter'd the same way, and the generator
// already produces the string-literal union type here (no numeric-enum mismatch to work around,
// unlike toTrackPhase's own note elsewhere in this file).
function toConflictingRecord(c: GeneratedConflictRecord): ConflictingRecord {
  return {
    record: toRecordSummary(c.record ?? {}),
    // ConflictRecord.record.origin (#278/ADR-0036: RecordSummary's own wire shape carries it,
    // this frontend's typed RecordSummary just never does — every other caller of
    // toRecordSummary already knows origin from its own node's scope, but a Conflicts-node entry
    // can be from any plugin at any origin, so it's threaded through separately here instead).
    origin: c.record?.origin ?? '',
    conflictAll: c.conflictAll ?? 'NoConflict',
  };
}

function toRecordTypeCount(r: PluginRecordTypeCount): { type: string; count: number; displayName: string } {
  const type = r.type ?? '';
  return { type, count: r.count ?? 0, displayName: r.displayName ?? type };
}

type GenWorldspace = components['schemas']['WorldspaceSummary'];
type GenCell = components['schemas']['CellSummary'];
type GenPlaced = components['schemas']['PlacedSummary'];

function toCellSummary(c: GenCell): CellSummary {
  return {
    formKey: c.formKey ?? '',
    editorId: c.editorId ?? null,
    cellX: c.cellX ?? null,
    cellY: c.cellY ?? null,
    isPersistentWorldspaceCell: c.isPersistentWorldspaceCell ?? false,
    fullName: c.fullName ?? null,
  };
}

function toPlacedSummary(p: GenPlaced): PlacedSummary {
  return {
    formKey: p.formKey ?? '',
    editorId: p.editorId ?? null,
    baseFormKey: p.baseFormKey ?? null,
    recordType: p.recordType ?? '',
  };
}

type GenContainerChild = components['schemas']['ContainerChildSummary'];

function toContainerChildSummary(c: GenContainerChild): ContainerChildSummary {
  return {
    formKey: c.formKey ?? '',
    editorId: c.editorId ?? null,
    plugin: c.plugin ?? '',
    origin: c.origin ?? '',
    loadOrderIndex: c.loadOrderIndex ?? 0,
    isWinner: c.isWinner ?? false,
    workingTreeState: toWorkingTreeState(c.workingTreeState),
    recordType: c.recordType ?? '',
  };
}

export interface RecordPage {
  items: RecordSummary[];
  total: number;
}

export interface CellPage {
  items: CellSummary[];
  total: number;
}

export interface PluginRepository {
  getPlugins(): Promise<PluginMetadata[]>;
  // #307 / ADR-0035: the load's own progress, polled alongside the in-flight load POST. Separate
  // from getPlugins() rather than folded into it: this one answers while the session is still
  // incomplete, and it is the only read that can distinguish "not looked yet" from "no conflict".
  getSessionStatus(): Promise<SessionStatus>;
  // #414 review F2: the Track gesture's own progress, polled alongside the in-flight track POST —
  // same idiom as getSessionStatus above.
  getTrackStatus(): Promise<TrackStatus>;
  // #417: every plugin currently holding an unanswered external-change question — polled the same
  // way, no session dependency of its own (the queue lives on the backend's singleton watcher).
  getExternalChangeStatus(): Promise<PendingExternalChange[]>;
  // origin (#34 / ADR-0036): which copy of `plugin` to read, when the session holds two files of
  // one filename. Optional — an ordinary load-order row has no origin to give, and the backend
  // resolves that case from the load order, where a filename is unambiguous.
  getRecordTypes(plugin: string, origin?: string): Promise<{ type: string; count: number; displayName: string }[]>;
  getRecords(plugin: string, type: string, offset: number, limit: number, origin?: string): Promise<RecordPage>;
  // #364: the Conflicts node's own listing — every contested record whose record-wide ConflictAll
  // isn't OnlyOne/NoConflict, already filter-narrowed by the backend (#278's mechanism). Throws on
  // a genuine fetch failure rather than degrading to [] — an empty Conflicts node has to mean
  // "nothing conflicts", never "the fetch failed", the same #307 invariant getRecords/
  // getRecordTypes already honour by throwing instead of hiding a failure as emptiness.
  getConflicts(): Promise<ConflictingRecord[]>;
  // Issue #210: the FormKey picker's own search — free-text `query` matched against EditorID or
  // (as of #210) a FormKey-shaped string, scoped to `validTypes` only when there's exactly one
  // (an unscoped/multi-type field searches across every record type, same as the deleted
  // webview-side RecordSessionClient.searchRecords this replaces). Capped at 20 results, matching
  // the old picker's page size.
  searchRecords(query: string, validTypes: string[]): Promise<RecordPage>;
  // #416 review: which plugin (+ origin) a FormKey's *winning* override belongs to — the record
  // editor's Save & Compile icon resolves its active record's owning plugin through this, rather
  // than falling through to an unfiltered QuickPick that can compile the wrong plugin in a
  // multi-mod session. undefined for an unknown FormKey (404) — never thrown, since "the actively
  // open record just isn't resolvable" is the caller's own fallback path, not a failure to report.
  getRecordOwner(formKey: string): Promise<{ plugin: string; origin: string } | undefined>;
  // #494: the Copy as Override destination picker's own exclusion data — every plugin already
  // holding an override (or the native/winning copy) of this FormKey, straight off GET
  // /records/{formKey}/compare's existing Overrides list; no dedicated endpoint needed. Empty for
  // an unknown FormKey (404), the same "not a fault" posture getRecordOwner's own 404 case uses.
  getRecordOverridePlugins(formKey: string): Promise<string[]>;
  // #544: the Stack node's "Compare with winner" bulk seam — every FormKey where `plugin`'s copy
  // at `winnerOrigin` and its copy at `peerOrigin` disagree, and only those. Empty for a vanished
  // peer/winner (404 — one of the two origins is no longer a loaded copy of `plugin` by the time
  // this reaches the backend), the same "not a fault" posture getRecordOverridePlugins' own 404
  // case above takes.
  getPluginDelta(plugin: string, winnerOrigin: string, peerOrigin: string): Promise<PluginDeltaEntry[]>;
  // #427: the Renumber gesture's FormID input box's suggested default — the same both-refs
  // allocator create/renumber use internally, exposed read-only (xEdit's own "New FormID
  // generated" flow). Never throws on the ordinary case; a genuine fault propagates like every
  // other read here.
  peekNextFreeFormKey(plugin: string, origin: string): Promise<string>;
  // Issue #211: the condition-function picker's catalog — every function name Mutagen resolves
  // for the loaded session's game, backing the extension-host QuickPick. Degrades to [] on a
  // failed fetch (mirrors setFilter/clearFilter's catch-and-log-no-throw below, not the
  // ensureOk-then-throw convention most reads here use) — a failed catalogue fetch must never
  // surface as a raw error, same as the deleted webview-side RecordSessionClient
  // .conditionFunctions() it replaces.
  getConditionFunctions(): Promise<string[]>;
  setFilter(sql: string): Promise<string | null>; // returns error message or null on success
  clearFilter(): Promise<void>;
  getActiveFilter(): Promise<string | null>;

  // Per-plugin worldspace tree. origin (#305 / ADR-0036): same optional shape as
  // getRecordTypes/getRecords above — a row that stands for a specific copy states it.
  /**
   * #415/ADR-0041: one field edit through the single write path. Never throws on a refusal — a
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
  // #424: a container record's own children (a Quest's dialog topics/branches/scenes, a Dialog
  // Topic's responses), in xEdit's own presentation order — same optional-origin shape as the
  // worldspace-tree reads above. Cells/worldspaces are unaffected: this reads Quest/DialogTopic
  // containment only, never Cell.NavigationMeshes/Landscape or Worldspace.TopCell/SubCells.
  getContainerChildren(plugin: string, parentFormKey: string, origin?: string): Promise<ContainerChildSummary[]>;

  // #448 / #34: the unlisted-plugin door — loads a file-level peer the load order doesn't name so
  // its own Stack-node entry can lazy-load its records, read-only, on first expansion. Idempotent
  // in effect (the backend re-serves an already-loaded copy rather than erroring — SessionManager's
  // own LoadUnlistedPlugin doc comment), so a caller never has to track "have I already loaded
  // this" itself.
  loadUnlistedPlugin(path: string, origin: string): Promise<void>;
  // #448 / #34: the mirror of loadUnlistedPlugin above — drops a peer's loaded copy, called when
  // its Stack-node row collapses, so a browsed-then-abandoned peer doesn't linger in the session
  // (#34 AC: "hidden means absent").
  unloadUnlistedPlugin(plugin: string, origin: string): Promise<void>;
}

export class ApiPluginRepository implements PluginRepository {
  private readonly log: (msg: string) => void;

  constructor(private readonly client: ApiClient, log?: (msg: string) => void) {
    this.log = log ?? (() => {});
  }

  // Don't swallow read failures into []/empty: a 503 "No session loaded", a 500,
  // or a network error must reach the tree so it renders an ErrorNode rather than
  // a silent empty list indistinguishable from genuinely empty data (issues #75,
  // #129, ADR-0026). A 200 with an empty/absent body is a legitimate empty result.
  // Genuine network-level throws propagate as-is. Mirrors the getPlugins convention.
  private ensureOk(what: string, response: Response, error?: unknown): void {
    if (response.ok) return;
    const text = errorText(error);
    const detail = text ? `: ${text}` : '';
    const msg = `${what} failed (${response.status})${detail}`;
    this.log(`[PluginRepository] ${msg}`);
    throw new Error(msg);
  }

  async getPlugins(): Promise<PluginMetadata[]> {
    const { data, error, response } = await this.client.GET('/plugins', {});
    this.ensureOk('GET /plugins', response, error);
    return (data ?? []).map(toPluginMetadata);
  }

  // #307: the endpoint answers 200 in every state including "no session" (SessionEndpoints.cs),
  // so a non-ok is a genuine fault and gets the same ensureOk treatment as every other read here.
  // Degrading it to an empty status would be indistinguishable from a load making no progress.
  async getSessionStatus(): Promise<SessionStatus> {
    const { data, error, response } = await this.client.GET('/session/status', {});
    this.ensureOk('GET /session/status', response, error);
    return {
      totalPlugins: data?.totalPlugins ?? 0,
      // The wire carries each entry's origin too; the consumer keys on filename alone (see
      // SessionStatus in ApiClient.ts), so it is dropped here rather than carried unused.
      indexedPlugins: (data?.indexedPlugins ?? []).map((p) => p.name ?? ''),
      conflictsComputed: data?.conflictsComputed ?? false,
      failures: (data?.failures ?? []).map((f) => ({ name: f.name ?? '', reason: f.reason ?? 'Unknown error' })),
    };
  }

  // #414 review F2: same "always 200, never degrade a fault into a fake idle" posture as
  // getSessionStatus above.
  async getTrackStatus(): Promise<TrackStatus> {
    const { data, error, response } = await this.client.GET('/plugins/track/status', {});
    this.ensureOk('GET /plugins/track/status', response, error);
    return {
      phase: toTrackPhase(data?.phase),
      pluginsDone: data?.pluginsDone ?? 0,
      pluginsTotal: data?.pluginsTotal ?? 0,
    };
  }

  // #417: same "always 200, never degrade a fault into a fake empty queue" posture as
  // getSessionStatus/getTrackStatus above.
  async getExternalChangeStatus(): Promise<PendingExternalChange[]> {
    const { data, error, response } = await this.client.GET('/plugins/external-changes/status', {});
    this.ensureOk('GET /plugins/external-changes/status', response, error);
    return (data ?? []).map((p) => ({
      plugin: p.plugin ?? '',
      origin: p.origin ?? '',
      metaChanged: p.metaChanged ?? false,
      oldVersion: p.oldVersion ?? null,
      newVersion: p.newVersion ?? null,
    }));
  }

  async getRecordTypes(plugin: string, origin?: string): Promise<{ type: string; count: number; displayName: string }[]> {
    const { data, error, response } = await this.client.GET('/plugins/{plugin}/record-types', {
      params: { path: { plugin }, query: origin === undefined ? {} : { origin } },
    });
    this.ensureOk(`getRecordTypes(${plugin})`, response, error);
    return (data ?? []).map(toRecordTypeCount);
  }

  async getRecords(plugin: string, type: string, offset: number, limit: number, origin?: string): Promise<RecordPage> {
    const { data, error, response } = await this.client.GET('/records', {
      params: { query: { plugin, type, offset, limit, ...(origin === undefined ? {} : { origin }) } },
    });
    this.ensureOk(`getRecords(${plugin}, ${type})`, response, error);
    return {
      items: (data?.items ?? []).map(toRecordSummary),
      total: data?.total ?? 0,
    };
  }

  async getConflicts(): Promise<ConflictingRecord[]> {
    const { data, error, response } = await this.client.GET('/records/conflicts', {});
    this.ensureOk('GET /records/conflicts', response, error);
    return (data ?? []).map(toConflictingRecord);
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
    return {
      items: (data?.items ?? []).map(toRecordSummary),
      total: data?.total ?? 0,
    };
  }

  async getRecordOwner(formKey: string): Promise<{ plugin: string; origin: string } | undefined> {
    const { data, error, response } = await this.client.GET('/records/{formKey}', { params: { path: { formKey } } });
    if (response.status === 404) return undefined;
    this.ensureOk(`getRecordOwner(${formKey})`, response, error);
    return data?.plugin && data.origin ? { plugin: data.plugin, origin: data.origin } : undefined;
  }

  // #494: see the interface's own doc comment — a 404 (unknown FormKey) is "nothing carries it
  // yet", not a fault, same posture as getRecordOwner's own 404 case above.
  async getRecordOverridePlugins(formKey: string): Promise<string[]> {
    const { data, error, response } = await this.client.GET('/records/{formKey}/compare', {
      params: { path: { formKey } },
    });
    if (response.status === 404) return [];
    this.ensureOk(`getRecordOverridePlugins(${formKey})`, response, error);
    return (data?.overrides ?? []).flatMap((o) => (o.plugin ? [o.plugin] : []));
  }

  // #544: see the interface's own doc comment. 404 is the vanished-origin case
  // (RecordQueryService.GetPluginDelta returning null) — "nothing to compare", not a fault.
  async getPluginDelta(plugin: string, winnerOrigin: string, peerOrigin: string): Promise<PluginDeltaEntry[]> {
    const { data, error, response } = await this.client.GET('/plugins/{plugin}/delta', {
      params: { path: { plugin }, query: { winnerOrigin, peerOrigin } },
    });
    if (response.status === 404) return [];
    this.ensureOk(`getPluginDelta(${plugin}, ${winnerOrigin}, ${peerOrigin})`, response, error);
    return (data ?? []).map(toPluginDeltaEntry);
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
      const { error, response } = await this.client.POST('/session/filter', { body: { sql } });
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
      const { error, response } = await this.client.DELETE('/session/filter', {});
      if (!response.ok) {
        const text = errorText(error);
        this.log(`[PluginRepository] clearFilter failed (${response.status}): ${text}`);
      }
    } catch (e) {
      this.log(`[PluginRepository] clearFilter failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async getActiveFilter(): Promise<string | null> {
    const { data, error, response } = await this.client.GET('/session/filter', {});
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
    const { data, error, response } = await this.client.GET('/plugins/{plugin}/worldspaces', {
      params: { path: { plugin }, query: origin === undefined ? {} : { origin } },
    });
    this.ensureOk(`getWorldspaces(${plugin})`, response, error);
    return (data ?? []).map((w: GenWorldspace) => ({
      formKey: w.formKey ?? '',
      editorId: w.editorId ?? null,
    }));
  }

  async getWorldspaceBlocks(plugin: string, worldspaceFormKey: string, origin?: string): Promise<WorldspaceBlocks> {
    const { data, error, response } = await this.client.GET('/plugins/{plugin}/worldspaces/{formKey}/blocks', {
      params: { path: { plugin, formKey: worldspaceFormKey }, query: origin === undefined ? {} : { origin } },
    });
    this.ensureOk(`getWorldspaceBlocks(${plugin}, ${worldspaceFormKey})`, response, error);
    return {
      topCells: (data?.topCells ?? []).map(toCellSummary),
      blocks: (data?.blocks ?? []).map(b => ({
        x: b.x ?? 0,
        y: b.y ?? 0,
        subBlocks: (b.subBlocks ?? []).map(s => ({
          x: s.x ?? 0,
          y: s.y ?? 0,
          cells: (s.cells ?? []).map(toCellSummary),
        })),
      })),
    };
  }

  async getCellReferences(plugin: string, cellFormKey: string, origin?: string): Promise<CellReferences> {
    const { data, error, response } = await this.client.GET('/plugins/{plugin}/cells/{formKey}/references', {
      params: { path: { plugin, formKey: cellFormKey }, query: origin === undefined ? {} : { origin } },
    });
    this.ensureOk(`getCellReferences(${plugin}, ${cellFormKey})`, response, error);
    return {
      persistent: (data?.persistent ?? []).map(toPlacedSummary),
      temporary: (data?.temporary ?? []).map(toPlacedSummary),
    };
  }

  async getInteriorCells(plugin: string, offset: number, limit: number, origin?: string): Promise<CellPage> {
    const { data, error, response } = await this.client.GET('/plugins/{plugin}/interior-cells', {
      params: { path: { plugin }, query: { offset, limit, ...(origin === undefined ? {} : { origin }) } },
    });
    this.ensureOk(`getInteriorCells(${plugin})`, response, error);
    return {
      items: (data?.items ?? []).map(toCellSummary),
      total: data?.total ?? 0,
    };
  }

  async getContainerChildren(plugin: string, parentFormKey: string, origin?: string): Promise<ContainerChildSummary[]> {
    const { data, error, response } = await this.client.GET('/plugins/{plugin}/records/{formKey}/children', {
      params: { path: { plugin, formKey: parentFormKey }, query: origin === undefined ? {} : { origin } },
    });
    this.ensureOk(`getContainerChildren(${plugin}, ${parentFormKey})`, response, error);
    return (data ?? []).map(toContainerChildSummary);
  }

  async loadUnlistedPlugin(path: string, origin: string): Promise<void> {
    const { error, response } = await this.client.POST('/plugins/load', { body: { path, origin } });
    this.ensureOk(`loadUnlistedPlugin(${path}, ${origin})`, response, error);
  }

  async unloadUnlistedPlugin(plugin: string, origin: string): Promise<void> {
    const { error, response } = await this.client.POST('/plugins/unload', { body: { plugin, origin } });
    this.ensureOk(`unloadUnlistedPlugin(${plugin}, ${origin})`, response, error);
  }

}
