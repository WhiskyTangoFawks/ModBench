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

    CompareResult? GetCompare(string formKey);

    /// <summary>#364: the Conflicts node's own listing — every contested record whose record-wide
    /// ConflictAll is not OnlyOne/NoConflict, filter-narrowed the same way GetRecords/
    /// GetPluginRecordTypes already are.</summary>
    IReadOnlyList<ConflictRecord> GetConflicts();

    IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string? origin = null);
    IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey);

    // The condition function picker's catalog (#152): every function name the loaded session's
    // game/category actually resolves — see ConditionCodecRegistry / IConditionCodec.AvailableFunctions.
    IReadOnlyList<string> GetConditionFunctions();

    // The Run On target list's catalog (#167): every RunOnType name the loaded session's
    // game/category actually resolves — see ConditionCodecRegistry / IConditionCodec.AvailableRunOnTargets.
    // Same rationale as GetConditionFunctions: not a hardcoded frontend array, so a future game's
    // differently-shaped RunOnType enum never silently offers a name it can't parse or write.
    IReadOnlyList<string> GetConditionRunOnTargets();

    // #421: GetRecordForPlugin/GetRecordType/GetNativeFormKeys/GetVmad/GetConditions/GetPlacement
    // are gone — all six were endpoint-orphaned pass-throughs to the repository (#413's D7
    // evidence), dying in the reshape's absorption of the read-model half of this service into
    // IRecordIndex. VMAD/condition reconstitution survives GetCompare's own needs internally
    // (RecordDocumentCodecs); nothing else called any of the six.
}
