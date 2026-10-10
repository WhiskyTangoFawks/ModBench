using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Index.Queries;

public interface IRecordQueryService
{
    Answer<IReadOnlyList<PluginRow>, IndexRefused> GetPlugins();
    // A null plugin browses every plugin.
    Answer<PagedResult<RecordSummary>, IndexRefused> GetRecords(
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset);
    Answer<RecordDetail?, IndexRefused> GetRecord(string formKey);

    Answer<CompareResult?, IndexRefused> GetCompare(string formKey, CopyText? text = null);

    Answer<CompareResult, IndexRefused> GetCompareRecords(IReadOnlyList<RecordCopy> copies);

    Answer<IReadOnlyList<PluginRecordTypeCount>, IndexRefused> GetPluginRecordTypes(PluginAddress plugin);
    Answer<WorkingTreeStatesBeneath, IndexRefused> GetWorkingTreeStatesBeneath(PluginAddress plugin);
    Answer<IReadOnlyList<RecordTypeChoice>, IndexRefused> GetCreatableRecordTypes();
    // Null when the plugin holds no such record.
    Answer<IReadOnlyList<RecordTypeChoice>?, IndexRefused> GetChildRecordTypes(PluginAddress plugin, string formKey);
    Answer<IReadOnlyList<ReferenceResult>, IndexRefused> GetReferences(string targetFormKey);
    Answer<IReadOnlyList<ReferenceResult>, IndexRefused> GetReferencesInActiveOrTrackedPlugins(string targetFormKey);
    // Null when the plugin holds no such record; a source stop when its source tree cannot say.
    Answer<RenderedDocument?, IndexRefused> GetRenderedDocument(PluginAddress plugin, string formKey);
    // Null when the plugin holds no such record; a source stop when its source tree cannot say.
    Answer<CopyDocument?, IndexRefused> GetCopyDocument(PluginAddress plugin, string formKey);
    Answer<RecordOfFileAnswer, IndexRefused> GetRecordOfFile(string path);

    // Answered in every state, "no load order yet" included (ADR-0013).
    LoadOrderStatus GetStatus();
    long GetSequence();
    Task<SequenceAwaitResponse> AwaitSequence(long atLeast, TimeSpan timeout);

    Answer<(string Sql, string Source)?, IndexRefused> GetFilter();
    // Why the SQL cannot be a filter, or no load order to hold it; null once it is in force.
    IndexRefused? SetFilter(string sql, string source);
    void ClearFilter();
    StoreRebuildRefused? RebuildStore(GameRelease gameRelease, string instanceRoot);
}
