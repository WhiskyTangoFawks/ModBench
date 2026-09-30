using MEditService.Index;
using Mutagen.Bethesda;

namespace MEditService.Queries;

public interface IRecordQueryService
{
    IReadOnlyList<PluginRow> GetPlugins();
    // plugin/origin (ADR-0012 invariant 1): both null browses every plugin; naming one names the
    // other too — a plugin filter with no origin would match every plugin sharing that filename.
    PagedResult<RecordSummary> GetRecords(
        string? type, string? plugin, string? search, int limit, int offset, string? origin = null, bool unfiltered = false);
    RecordDetail? GetRecord(string formKey);

    CompareResult? GetCompare(string formKey);

    IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string origin);
    IReadOnlyList<CreatableRecordType> GetCreatableRecordTypes();
    IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey);

    void SetFilter(string sql, string source);
    void ClearFilter();
    Task RebuildStore(GameRelease gameRelease, string instanceRoot);
}
