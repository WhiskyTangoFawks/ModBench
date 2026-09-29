using MEditService.Index;
using Mutagen.Bethesda;

namespace MEditService.Queries;

public interface IRecordQueryService
{
    IReadOnlyList<PluginRow> GetPlugins();
    // origin (ADR-0012): which plugin named `plugin` to browse. Optional because most callers have
    // only a filename; omitted, it is resolved server-side from the load order.
    PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset, string? origin = null);
    RecordDetail? GetRecord(string formKey);

    CompareResult? GetCompare(string formKey);

    IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string? origin = null);
    IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey);

    // target-architecture.d2 medit_core.queries: set and clear the record filter, and rebuild the
    // index. Both change only the derived store.
    void SetFilter(string sql, string source);
    void ClearFilter();
    Task RebuildStore(GameRelease gameRelease, string instanceRoot);
}
