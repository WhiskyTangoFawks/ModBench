using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Queries;

/// <summary>The record index's face (ADR-0014): what the API asks of the read model. A read that returns a task sees
/// every source write mEdit made before it, and waits for that without holding a thread.</summary>
public interface IQueries
{
    Task<Answer<IReadOnlyList<PluginResponse>, IndexRefused>> GetPlugins(CancellationToken cancel);
    // A null plugin browses every plugin.
    Task<Answer<PagedResult<RecordSummary>, IndexRefused>> GetRecords(
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset, CancellationToken cancel);
    Task<Answer<RecordDetail?, IndexRefused>> GetRecord(string formKey, CancellationToken cancel);

    Task<Answer<CompareResult?, IndexRefused>> GetCompare(string formKey, CopyText? text, CancellationToken cancel);

    Task<Answer<CompareRecordsAnswer, IndexRefused>> GetCompareRecords(IReadOnlyList<RecordCopy> copies, CancellationToken cancel);

    // Given a plugin, each stack holds that plugin and its masters; given none, the active load order.
    Task<Answer<IReadOnlyList<RecordCopyStates>, IndexRefused>> GetCopyStates(
        IReadOnlyList<string> formKeys, PluginAddress? plugin, CancellationToken cancel);

    Task<Answer<IReadOnlyList<PluginRecordTypeCount>, IndexRefused>> GetPluginRecordTypes(PluginAddress plugin, CancellationToken cancel);
    Task<Answer<WorkingTreeStatesBeneath, IndexRefused>> GetWorkingTreeStatesBeneath(PluginAddress plugin, CancellationToken cancel);
    Answer<IReadOnlyList<RecordTypeChoice>, IndexRefused> GetCreatableRecordTypes();
    Answer<IReadOnlyList<string>, IndexRefused> GetCreatablePluginExtensions();
    Answer<IReadOnlyList<IReadOnlyList<string>>, IndexRefused> GetCreatablePluginFlags(string name);
    // Null when the plugin holds no such record.
    Task<Answer<IReadOnlyList<RecordTypeChoice>?, IndexRefused>> GetChildRecordTypes(
        PluginAddress plugin, string formKey, CancellationToken cancel);
    Task<Answer<IReadOnlyList<ReferenceResult>, IndexRefused>> GetReferences(string targetFormKey, CancellationToken cancel);
    Task<Answer<IReadOnlyList<ReferenceResult>, IndexRefused>> GetReferencesInActiveOrCompiledPlugins(
        string targetFormKey, CancellationToken cancel);
    Task<Answer<IReadOnlyList<CopyNaming>, IndexRefused>> GetPluginNameReferences(string name, CancellationToken cancel);
    /// <summary>Each copy, in an active plugin with no plugin source, that copies or links the record <paramref name="plugin"/> holds.
    /// No source write of mEdit's changes such a copy, so it waits for none.</summary>
    Answer<IReadOnlyList<RecordAt>, IndexRefused> GetCopiesWithNoPluginSourceNaming(PluginAddress plugin, string formKey);
    Task<Answer<MemberReferences, IndexRefused>> GetScriptReferences(string name, CancellationToken cancel);
    /// <summary>Each copy, in an active or compiled plugin, that names the file at <paramref name="dataPath"/> in the Data
    /// folder, as Mutagen places the path each asset link holds.</summary>
    Task<Answer<MemberReferences, IndexRefused>> GetFileReferences(string dataPath, CancellationToken cancel);
    // Null when the plugin holds no such record; a source stop when its source tree cannot say.
    Task<Answer<RenderedDocument?, IndexRefused>> GetRenderedDocument(PluginAddress plugin, string formKey, CancellationToken cancel);
    // Null when the plugin holds no such record; a source stop when its source tree cannot say.
    Task<Answer<CopyDocument?, IndexRefused>> GetCopyDocument(PluginAddress plugin, string formKey, CancellationToken cancel);
    Answer<RecordOfFileAnswer, IndexRefused> GetRecordOfFile(string path);

    Task<Answer<IReadOnlyList<WorldspaceSummary>, IndexRefused>> GetWorldspaces(PluginAddress plugin, CancellationToken cancel);
    Task<Answer<WorldspaceBlocks, IndexRefused>> GetWorldspaceBlocks(
        PluginAddress plugin, string worldspaceFormKey, CancellationToken cancel);
    Task<Answer<CellChildRecords, IndexRefused>> GetCellChildRecords(PluginAddress plugin, string cellFormKey, CancellationToken cancel);
    Task<Answer<IReadOnlyList<InteriorCellBlock>, IndexRefused>> GetInteriorCells(PluginAddress plugin, CancellationToken cancel);
    Task<Answer<IReadOnlyList<ContainerChildSummary>, IndexRefused>> GetContainerChildren(
        PluginAddress plugin, string parentFormKey, CancellationToken cancel);

    Task<Answer<IReadOnlyList<PluginDiagnosisReport>, IndexRefused>> GetLoadOrderDiagnoses(CancellationToken cancel);
    Task<Answer<PluginDependants, IndexRefused>> GetDependants(PluginAddress plugin, CancellationToken cancel);
    Answer<PluginIndexedState, IndexRefused> GetPluginIndexedAsOnDisk(PluginAddress plugin);
    Task<Answer<IReadOnlyList<PluginProblems>, IndexRefused>> GetProblems(CancellationToken cancel);
    Task<Answer<IReadOnlyList<PluginFilePaths>, IndexRefused>> GetFilePaths(PluginAddress? plugin, CancellationToken cancel);

    // Answered in every state, "no load order yet" included (ADR-0013).
    LoadOrderStatus GetStatus();
    long GetSequence();
    Task<SequenceAwaitResponse> AwaitSequence(long atLeast, TimeSpan timeout);

    Answer<RecordFilter?, IndexRefused> GetFilter();
    // Why the SQL cannot be a filter, or no load order to hold it; null once it is in force.
    IndexRefused? SetFilter(string sql, string source);
    void ClearFilter();
    // The rows of one SELECT over the views of every plugin the record index holds, read as they are taken; the filter in force does not narrow them. The caller disposes them.
    Task<Answer<SelectedRows, IndexRefused>> SelectRows(string sql, CancellationToken cancel);
    // One object per name, in order; refused whole when any name means nothing or more than one thing.
    Task<Answer<IReadOnlyList<NamedObject>, IndexRefused>> ResolveNames(IReadOnlyList<NameQuery> names, CancellationToken cancel);
    StoreRebuildRefused? RebuildStore(GameRelease gameRelease, string instanceRoot);
}
