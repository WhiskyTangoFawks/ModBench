using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;

namespace MEditService.Core.Queries;

public interface IRecordQueryService
{
    IReadOnlyList<PluginResponse> GetPlugins();
    // origin (ADR-0012): which copy of `plugin` to browse. Optional because most callers have only
    // a filename; omitted, it is resolved server-side from the load order.
    PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset, string? origin = null);
    RecordDetail? GetRecord(string formKey);

    CompareResult? GetCompare(string formKey);

    IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string? origin = null);
    IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey);
}
