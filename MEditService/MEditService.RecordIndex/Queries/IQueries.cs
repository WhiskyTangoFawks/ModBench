using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Queries;

/// <summary>The record index's face (ADR-0014): what the API asks of the read model. A write waits here for the read of its own
/// source writes; no read does.</summary>
public interface IQueries
{
    /// <summary>Every plugin, or only <paramref name="plugins"/> (ADR-0012): the same facts either way.</summary>
    Answer<IReadOnlyList<PluginResponse>, IndexRefused> GetPlugins(IReadOnlyCollection<PluginAddress>? plugins = null);
    // A null plugin browses every plugin.
    Answer<PagedResult<RecordSummary>, IndexRefused> GetRecords(
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset);
    /// <summary>The plugin of the winning copy of <paramref name="formKey"/>; with no active plugin holding it, each compiled
    /// plugin that does (ADR-0012).</summary>
    Answer<IReadOnlyList<PluginAddress>, IndexRefused> GetRecordOwners(string formKey);

    Answer<CompareResult?, IndexRefused> GetCompare(string formKey, CopyText? text);

    Answer<CompareRecordsAnswer, IndexRefused> GetCompareRecords(IReadOnlyList<RecordCopy> copies);

    // Given a plugin, each stack holds that plugin and its masters; given none, the active load order.
    Answer<IReadOnlyList<RecordCopyStates>, IndexRefused> GetCopyStates(
        IReadOnlyList<string> formKeys, PluginAddress? plugin);

    Answer<IReadOnlyList<PluginRecordTypeCount>, IndexRefused> GetPluginRecordTypes(PluginAddress plugin);
    Answer<WorkingTreeStatesBeneath, IndexRefused> GetWorkingTreeStatesBeneath(PluginAddress plugin);
    Answer<IReadOnlyList<RecordTypeChoice>, IndexRefused> GetCreatableRecordTypes();
    Answer<IReadOnlyList<string>, IndexRefused> GetCreatablePluginExtensions();
    Answer<IReadOnlyList<IReadOnlyList<string>>, IndexRefused> GetCreatablePluginFlags(string name);
    // Null when the plugin holds no such record.
    Answer<IReadOnlyList<RecordTypeChoice>?, IndexRefused> GetChildRecordTypes(
        PluginAddress plugin, string formKey);
    Answer<IReadOnlyList<ReferenceResult>, IndexRefused> GetReferencesInActiveOrCompiledPlugins(
        string targetFormKey);
    Answer<PlacedReferences, IndexRefused> GetPlacedReferences(string targetFormKey);
    Answer<IReadOnlyList<CopyNaming>, IndexRefused> GetPluginNameReferences(string name);
    /// <summary>Each copy, in an active plugin with no plugin source, that copies or links the record <paramref name="plugin"/> holds.
    /// No source write of mEdit's changes such a copy.</summary>
    Answer<IReadOnlyList<RecordAt>, IndexRefused> GetCopiesWithNoPluginSourceNaming(PluginAddress plugin, string formKey);
    Answer<MemberReferences, IndexRefused> GetScriptReferences(string name);
    /// <summary>Each copy, in an active or compiled plugin, that names the file at <paramref name="dataPath"/> in the Data
    /// folder, as Mutagen places the path each asset link holds.</summary>
    Answer<MemberReferences, IndexRefused> GetFileReferences(string dataPath);
    // Null when the plugin holds no such record; a source stop when its source tree cannot say.
    Answer<RenderedDocument?, IndexRefused> GetRenderedDocument(PluginAddress plugin, string formKey);
    // Null when the plugin holds no such record; a source stop when its source tree cannot say.
    Answer<CopyDocument?, IndexRefused> GetCopyDocument(PluginAddress plugin, string formKey);
    Answer<RecordOfFileAnswer, IndexRefused> GetRecordOfFile(string path);
    /// <summary>The names a document's text holds, and where each sits; with <paramref name="at"/>, those at that offset.
    /// Given the <paramref name="path"/> of a file no plugin's source holds, none.</summary>
    Answer<IReadOnlyList<DocumentName>, IndexRefused> GetPluginSourceNames(string? path, string text, int? at);

    Answer<IReadOnlyList<WorldspaceSummary>, IndexRefused> GetWorldspaces(PluginAddress plugin);
    Answer<WorldspaceBlocks, IndexRefused> GetWorldspaceBlocks(
        PluginAddress plugin, string worldspaceFormKey);
    Answer<CellChildRecords, IndexRefused> GetCellChildRecords(PluginAddress plugin, string cellFormKey);
    Answer<IReadOnlyList<InteriorCellBlock>, IndexRefused> GetInteriorCells(PluginAddress plugin);
    Answer<IReadOnlyList<ContainerChildSummary>, IndexRefused> GetContainerChildren(
        PluginAddress plugin, string parentFormKey);

    Answer<IReadOnlyList<PluginDiagnosisReport>, IndexRefused> GetLoadOrderDiagnoses();
    Answer<PluginDependants, IndexRefused> GetDependants(PluginAddress plugin);
    Answer<PluginIndexedState, IndexRefused> GetPluginIndexedAsOnDisk(PluginAddress plugin);
    Answer<IReadOnlyList<IndexOfPlugin>, IndexRefused> GetPluginsIndexing();
    Answer<IReadOnlyList<PluginProblems>, IndexRefused> GetProblems(PluginAddress? plugin, RecordsAsked? asked = null);
    Answer<IReadOnlyList<PluginFilePaths>, IndexRefused> GetFilePaths(PluginAddress? plugin, RecordsAsked? asked = null);

    /// <summary>Null once the record index holds each plugin <paramref name="written"/> names, or once a check of the disk has
    /// read it when null; otherwise why not (ADR-0029).</summary>
    Task<string?> Hold(IReadOnlyList<HandedPlugin>? written, CancellationToken cancel);

    // Answered in every state, "no load order yet" included (ADR-0013).
    LoadOrderStatus GetStatus();
    long GetSequence();
    Task<SequenceAwaitResponse> AwaitSequence(long atLeast, TimeSpan timeout);

    Answer<RecordFilter?, IndexRefused> GetFilter();
    // Replaces which compiled plugins of a mod changed outside Modbench (ADR-0003), and answers the plugins whose standing flipped.
    IReadOnlyList<PluginAddress> SetChangedOutside(string origin, IReadOnlyList<string> plugins);
    // Null when the filter was not cleared.
    FilterCleared? GetFilterCleared();
    // Why the SQL cannot be a filter, or no load order to hold it; null once it is in force.
    IndexRefused? SetFilter(string sql, string source);
    void ClearFilter();
    // The rows of one SELECT over the views of every plugin the record index holds, read as they are taken; the filter in force does not narrow them. The caller disposes them.
    Answer<SelectedRows, IndexRefused> SelectRows(string sql);
    // One object per name, in order; refused whole when any name means nothing or more than one thing.
    Answer<IReadOnlyList<NamedObject>, IndexRefused> ResolveNames(IReadOnlyList<NameQuery> names);
    StoreRebuildRefused? RebuildStore(GameRelease gameRelease, string instanceRoot);
}
