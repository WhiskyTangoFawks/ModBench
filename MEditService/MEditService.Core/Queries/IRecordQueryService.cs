using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;

namespace MEditService.Core.Queries;

public interface IRecordQueryService
{
    IReadOnlyList<PluginResponse> GetPlugins();
    // origin (ADR-0036): which copy of `plugin` to browse, when the load order holds two of one
    // filename. Optional because most callers legitimately have only a filename — omitted, the
    // origin is resolved server-side from the load order, correct wherever a filename names one
    // loaded copy.
    PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset, string? origin = null);
    RecordDetail? GetRecord(string formKey);

    CompareResult? GetCompare(string formKey);

    /// <summary>The Conflicts node's own listing — every contested record whose record-wide
    /// ConflictAll is not OnlyOne/NoConflict, filter-narrowed the same way GetRecords/
    /// GetPluginRecordTypes already are.</summary>
    IReadOnlyList<ConflictRecord> GetConflicts();

    IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string? origin = null);
    IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey);

    // The condition function picker's catalog: every function name the loaded load order's
    // game/category actually resolves — see ConditionCodecRegistry / IConditionCodec.AvailableFunctions.
    IReadOnlyList<string> GetConditionFunctions();

    // The Run On target list's catalog: every RunOnType name the loaded load order's
    // game/category actually resolves — see ConditionCodecRegistry / IConditionCodec.AvailableRunOnTargets.
    // Same rationale as GetConditionFunctions: not a hardcoded frontend array, so a future game's
    // differently-shaped RunOnType enum never silently offers a name it can't parse or write.
    IReadOnlyList<string> GetConditionRunOnTargets();
}
