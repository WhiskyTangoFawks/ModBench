using MEditService.LoadOrder;
using MEditService.Ports;
using Mutagen.Bethesda;

namespace MEditService.Queries;

public interface IRecordQueryService
{
    IReadOnlyList<PluginRow> GetPlugins();
    // A null plugin browses every plugin.
    PagedResult<RecordSummary> GetRecords(
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset, bool unfiltered = false);
    RecordDetail? GetRecord(string formKey);

    CompareResult? GetCompare(string formKey);

    // One column per copy, in the order given, and no conflict state on any of them; null when a copy
    // has no document to read.
    CompareResult? GetCompareRecords(IReadOnlyList<RecordCopy> copies);

    IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(PluginAddress plugin);
    IReadOnlyList<CreatableRecordType> GetCreatableRecordTypes();
    bool GetLightPluginsSupported();
    IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey);

    // Answered in every state, "no load order yet" included (ADR-0013).
    LoadOrderStatus GetStatus();
    long GetSequence();
    Task<SequenceAwaitResponse> AwaitSequence(long atLeast, TimeSpan timeout);

    (string Sql, string Source)? GetFilter();
    void SetFilter(string sql, string source);
    void ClearFilter();
    // The refusal (ADR-0010, ADR-0019) when another window holds this instance's index; null when it
    // rebuilt.
    string? RebuildStore(GameRelease gameRelease, string instanceRoot);
}
