using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;

namespace MEditService.Core.Queries;

public interface IRecordQueryService
{
    IReadOnlyList<PluginResponse> GetPlugins();
    IReadOnlyList<string> GetRecordTypes();
    PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset);
    RecordDetail? GetRecord(string formKey);
    RecordDetail? GetRecordForPlugin(string formKey, string plugin);
    string? GetRecordType(string formKey);
    IReadOnlyList<string> GetNativeFormKeys(string plugin);
    CompareResult? GetCompare(string formKey);
    IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin);
    IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey);
    VmadData? GetVmad(string formKey, string plugin, string origin = PluginOrigin.DataDirectory);
    IReadOnlyList<ConditionOwner> GetConditions(string formKey, string plugin, string origin = PluginOrigin.DataDirectory);

    // The condition function picker's catalog (#152): every function name the loaded session's
    // game/category actually resolves — see ConditionCodecRegistry / IConditionCodec.AvailableFunctions.
    IReadOnlyList<string> GetConditionFunctions();

    // The Run On target list's catalog (#167): every RunOnType name the loaded session's
    // game/category actually resolves — see ConditionCodecRegistry / IConditionCodec.AvailableRunOnTargets.
    // Same rationale as GetConditionFunctions: not a hardcoded frontend array, so a future game's
    // differently-shaped RunOnType enum never silently offers a name it can't parse or write.
    IReadOnlyList<string> GetConditionRunOnTargets();

    PlacementRow? GetPlacement(string formKey, string plugin, string origin = PluginOrigin.DataDirectory);

    // ADR-0031: the /changes read surface (Pending Changes tree, pending-column rendering) — each
    // PendingChange's NewValue gets its FormKey-typed leaves resolved in one batched pass via
    // PendingChangeResolver, same lookup as GetCompare's FieldDiff resolution.
    IReadOnlyList<PendingChange> GetChanges(string? plugin = null, string? formKey = null, Guid? memberChangeId = null);
}
