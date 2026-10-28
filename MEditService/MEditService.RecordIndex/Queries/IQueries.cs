using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Queries;

/// <summary>The record index's face (ADR-0014): what the API asks of the read model.</summary>
public interface IQueries
{
    Answer<IReadOnlyList<PluginResponse>, IndexRefused> GetPlugins();
    // A null plugin browses every plugin.
    Answer<PagedResult<RecordSummary>, IndexRefused> GetRecords(
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset);
    Answer<RecordDetail?, IndexRefused> GetRecord(string formKey);

    Answer<CompareResult?, IndexRefused> GetCompare(string formKey, CopyText? text = null);

    Answer<CompareRecordsAnswer, IndexRefused> GetCompareRecords(IReadOnlyList<RecordCopy> copies);

    Answer<IReadOnlyList<PluginRecordTypeCount>, IndexRefused> GetPluginRecordTypes(PluginAddress plugin);
    Answer<WorkingTreeStatesBeneath, IndexRefused> GetWorkingTreeStatesBeneath(PluginAddress plugin);
    Answer<IReadOnlyList<RecordTypeChoice>, IndexRefused> GetCreatableRecordTypes();
    Answer<IReadOnlyList<string>, IndexRefused> GetCreatablePluginExtensions();
    // Null when the plugin holds no such record.
    Answer<IReadOnlyList<RecordTypeChoice>?, IndexRefused> GetChildRecordTypes(PluginAddress plugin, string formKey);
    Answer<IReadOnlyList<ReferenceResult>, IndexRefused> GetReferences(string targetFormKey);
    Answer<IReadOnlyList<ReferenceResult>, IndexRefused> GetReferencesInActiveOrCompiledPlugins(string targetFormKey);
    // Null when the plugin holds no such record; a source stop when its source tree cannot say.
    Answer<RenderedDocument?, IndexRefused> GetRenderedDocument(PluginAddress plugin, string formKey);
    // Null when the plugin holds no such record; a source stop when its source tree cannot say.
    Answer<CopyDocument?, IndexRefused> GetCopyDocument(PluginAddress plugin, string formKey);
    Answer<RecordOfFileAnswer, IndexRefused> GetRecordOfFile(string path);

    Answer<IReadOnlyList<WorldspaceSummary>, IndexRefused> GetWorldspaces(PluginAddress plugin);
    Answer<WorldspaceBlocks, IndexRefused> GetWorldspaceBlocks(PluginAddress plugin, string worldspaceFormKey);
    Answer<CellChildRecords, IndexRefused> GetCellChildRecords(PluginAddress plugin, string cellFormKey);
    Answer<IReadOnlyList<InteriorCellBlock>, IndexRefused> GetInteriorCells(PluginAddress plugin);
    Answer<IReadOnlyList<ContainerChildSummary>, IndexRefused> GetContainerChildren(PluginAddress plugin, string parentFormKey);

    Answer<IReadOnlyList<PluginDiagnosisReport>, IndexRefused> GetLoadOrderDiagnoses();
    Answer<PluginDependants, IndexRefused> GetDependants(PluginAddress plugin);
    // Whether its rows were built from the file now on disk (ADR-0003); false for a plugin the record index holds no rows for.
    Answer<bool, IndexRefused> GetPluginIndexedAsOnDisk(PluginAddress plugin);
    Answer<IReadOnlyList<PluginProblems>, IndexRefused> GetProblems();

    // Answered in every state, "no load order yet" included (ADR-0013).
    LoadOrderStatus GetStatus();
    long GetSequence();
    Task<SequenceAwaitResponse> AwaitSequence(long atLeast, TimeSpan timeout);

    Answer<RecordFilter?, IndexRefused> GetFilter();
    // Why the SQL cannot be a filter, or no load order to hold it; null once it is in force.
    IndexRefused? SetFilter(string sql, string source);
    void ClearFilter();
    // The rows of one SELECT over the views of every plugin the record index holds, each a JSON object of its columns; the filter in force does not narrow them.
    Answer<SelectedRows, IndexRefused> SelectRows(string sql);
    // One object per name, in order; refused whole when any name means nothing or more than one thing.
    Answer<IReadOnlyList<NamedObject>, IndexRefused> ResolveNames(IReadOnlyList<NameQuery> names);
    StoreRebuildRefused? RebuildStore(GameRelease gameRelease, string instanceRoot);
}
