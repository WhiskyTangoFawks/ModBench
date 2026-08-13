using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;

namespace MEditService.Core.Queries;

public interface IRecordQueryService
{
    IReadOnlyList<PluginResponse> GetPlugins();
    IReadOnlyList<string> GetRecordTypes();
    // origin (#34 / ADR-0036): which copy of `plugin` to browse, when the session holds two of one
    // filename. Optional because most callers legitimately have only a filename — omitted, the
    // origin is resolved server-side from the load order, which is what every caller did before
    // #34 and is still correct wherever a filename names one loaded copy.
    PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset, string? origin = null);
    RecordDetail? GetRecord(string formKey);
    // origin (#296 / ADR-0036, required): same reasoning as GetVmad's — caller-supplied, since
    // EditOrchestrator (the only caller) already resolves it via ResolveOrigin right alongside its
    // neighboring GetVmad/GetConditions/GetPlacement calls.
    RecordDetail? GetRecordForPlugin(string formKey, string plugin, string origin);
    string? GetRecordType(string formKey);
    // origin (#296 / ADR-0036, required): caller-supplied, same reasoning as GetRecordForPlugin's —
    // EditOrchestrator (the only caller) already resolves it via ResolveOrigin right alongside the
    // neighboring GetPendingNativeFormKeyChanges call.
    IReadOnlyList<string> GetNativeFormKeys(string plugin, string origin);
    CompareResult? GetCompare(string formKey);
    IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string? origin = null);
    IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey);
    VmadData? GetVmad(string formKey, string plugin, string origin);
    IReadOnlyList<ConditionOwner> GetConditions(string formKey, string plugin, string origin);

    // The condition function picker's catalog (#152): every function name the loaded session's
    // game/category actually resolves — see ConditionCodecRegistry / IConditionCodec.AvailableFunctions.
    IReadOnlyList<string> GetConditionFunctions();

    // The Run On target list's catalog (#167): every RunOnType name the loaded session's
    // game/category actually resolves — see ConditionCodecRegistry / IConditionCodec.AvailableRunOnTargets.
    // Same rationale as GetConditionFunctions: not a hardcoded frontend array, so a future game's
    // differently-shaped RunOnType enum never silently offers a name it can't parse or write.
    IReadOnlyList<string> GetConditionRunOnTargets();

    PlacementRow? GetPlacement(string formKey, string plugin, string origin);

    // ADR-0031: the /changes read surface (Pending Changes tree, pending-column rendering) — each
    // PendingChange's NewValue gets its FormKey-typed leaves resolved in one batched pass via
    // PendingChangeResolver, same lookup as GetCompare's FieldDiff resolution.
    // #296: `plugin` is deliberately absent — no caller (frontend, MCP, or otherwise) ever filtered
    // by it, so it was a filename-only-keyed parameter with no requirement behind it (the
    // NOT-a-caller-so-not-a-gap distinction the issue itself draws for this endpoint). Deleting it
    // removes the problem outright rather than threading an origin only this parameter would need.
    // If a real caller needs plugin-filtered changes later, add it back with origin from the start.
    IReadOnlyList<PendingChange> GetChanges(string? formKey = null, Guid? memberChangeId = null);
}
