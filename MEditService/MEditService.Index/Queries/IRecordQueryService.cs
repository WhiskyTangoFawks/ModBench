using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Index.Queries;

public interface IRecordQueryService
{
    IReadOnlyList<PluginRow> GetPlugins();
    // A null plugin browses every plugin.
    PagedResult<RecordSummary> GetRecords(
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset);
    RecordDetail? GetRecord(string formKey);

    CompareResult? GetCompare(string formKey, CopyText? text = null);

    CompareResult? GetCompareRecords(IReadOnlyList<RecordCopy> copies);

    IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(PluginAddress plugin);
    IReadOnlyList<RecordTypeChoice> GetCreatableRecordTypes();
    // Null when the plugin holds no such record.
    IReadOnlyList<RecordTypeChoice>? GetChildRecordTypes(PluginAddress plugin, string formKey);
    IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey);
    // Null when the plugin holds no such record.
    RenderedDocument? GetRenderedDocument(PluginAddress plugin, string formKey);
    // Null when the plugin holds no such record.
    RecordFile? GetRecordFile(PluginAddress plugin, string formKey);
    RecordOfFileAnswer GetRecordOfFile(string path);

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
