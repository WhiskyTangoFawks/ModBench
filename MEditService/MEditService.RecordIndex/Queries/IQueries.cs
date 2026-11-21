using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
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
    Answer<IReadOnlyList<PluginResponse>, IndexRefused> GetPlugins(IReadOnlyCollection<PluginAddress>? plugins, CancellationToken cancel);
    // A null plugin browses every plugin.
    Answer<PagedResult<RecordSummary>, IndexRefused> GetRecords(
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset, CancellationToken cancel);
    /// <summary>Of each of <paramref name="formKeys"/>, the plugin of its winning copy; with no active plugin holding it, each
    /// compiled plugin that does (ADR-0012). Keyed ignoring case, as the record index matches a FormKey.</summary>
    Answer<IReadOnlyDictionary<string, IReadOnlyList<PluginAddress>>, IndexRefused> GetRecordOwners(
        IReadOnlyCollection<string> formKeys, CancellationToken cancel);

    /// <summary>The same, for a write that bakes it into a file: refused unless Ready on the write's load order
    /// <paramref name="version"/>, and still on <paramref name="decision"/>, its first ask's.</summary>
    Answer<DecidedOwners, IndexRefused> GetRecordOwnersForAWrite(
        long version, long? decision, IReadOnlyCollection<string> formKeys, CancellationToken cancel);

    Answer<CompareResult?, IndexRefused> GetCompare(string formKey, CopyText? text, CancellationToken cancel);

    Answer<CompareRecordsAnswer, IndexRefused> GetCompareRecords(IReadOnlyList<RecordCopy> copies, CancellationToken cancel);

    // Given a plugin, each stack holds that plugin and its masters; given none, the active load order.
    Answer<IReadOnlyList<RecordCopyStates>, IndexRefused> GetCopyStates(
        IReadOnlyList<string> formKeys, PluginAddress? plugin, CancellationToken cancel);

    Answer<IReadOnlyList<PluginRecordTypeCount>, IndexRefused> GetPluginRecordTypes(PluginAddress plugin, CancellationToken cancel);
    Answer<WorkingTreeStatesBeneath, IndexRefused> GetWorkingTreeStatesBeneath(PluginAddress plugin, CancellationToken cancel);
    Answer<IReadOnlyList<RecordTypeChoice>, IndexRefused> GetCreatableRecordTypes();
    Answer<IReadOnlyList<string>, IndexRefused> GetCreatablePluginExtensions();
    Answer<IReadOnlyList<IReadOnlyList<string>>, IndexRefused> GetCreatablePluginFlags(string name);
    /// <summary>Each place of the load order, by its origin, whose plugin source holds the plugin <paramref name="name"/>, so a create
    /// there refuses.</summary>
    Answer<IReadOnlyList<string>, IndexRefused> GetPlacesHoldingPluginSource(string name);
    // Null when the plugin holds no such record.
    Answer<IReadOnlyList<RecordTypeChoice>?, IndexRefused> GetChildRecordTypes(
        PluginAddress plugin, string formKey, CancellationToken cancel);
    Answer<IReadOnlyList<ReferenceResult>, IndexRefused> GetReferencesInActiveOrCompiledPlugins(
        string targetFormKey, CancellationToken cancel);
    Answer<PlacedReferences, IndexRefused> GetPlacedReferences(string targetFormKey, CancellationToken cancel);
    Answer<PlacedReferences, IndexRefused> GetPlacedPluginNameReferences(string name, CancellationToken cancel);
    Answer<PlacedReferences, IndexRefused> GetPlacedScriptReferences(string name, CancellationToken cancel);
    /// <summary>Each copy, in an active or compiled plugin, that names the file at <paramref name="dataPath"/> in the Data
    /// folder, as Mutagen places the path each asset link holds, placed at its document.</summary>
    Answer<PlacedReferences, IndexRefused> GetPlacedFileReferences(string dataPath, CancellationToken cancel);
    Answer<IReadOnlyList<CopyNaming>, IndexRefused> GetPluginNameReferences(string name, CancellationToken cancel);
    /// <summary>Each copy, in an active plugin with no plugin source, that copies or links the record <paramref name="plugin"/> holds.
    /// No source write of mEdit's changes such a copy.</summary>
    Answer<IReadOnlyList<RecordAt>, IndexRefused> GetCopiesWithNoPluginSourceNaming(PluginAddress plugin, string formKey, CancellationToken cancel);
    Answer<MemberReferences, IndexRefused> GetScriptReferences(string name, CancellationToken cancel);
    // Null when the plugin holds no such record; a source stop when its source tree cannot say.
    Answer<RenderedDocument?, IndexRefused> GetRenderedDocument(PluginAddress plugin, string formKey, CancellationToken cancel);
    // Null when the plugin holds no such record; a source stop when its source tree cannot say.
    Answer<CopyDocument?, IndexRefused> GetCopyDocument(PluginAddress plugin, string formKey, CancellationToken cancel);
    Answer<CopyDocument?, IndexRefused> GetCopyDocument(PluginAddress plugin, RecordIdentity identity, CancellationToken cancel);
    Answer<RecordOfFileAnswer, IndexRefused> GetRecordOfFile(string path);
    /// <summary>The names a document's text holds, and where each sits; with <paramref name="at"/>, those at that offset.
    /// Given the <paramref name="path"/> of a file no plugin's source holds, none.</summary>
    Answer<IReadOnlyList<DocumentName>, IndexRefused> GetPluginSourceNames(string? path, string text, int? at, CancellationToken cancel);

    Answer<IReadOnlyList<WorldspaceSummary>, IndexRefused> GetWorldspaces(PluginAddress plugin, CancellationToken cancel);
    Answer<WorldspaceBlocks, IndexRefused> GetWorldspaceBlocks(
        PluginAddress plugin, string worldspaceFormKey, CancellationToken cancel);
    Answer<CellChildRecords, IndexRefused> GetCellChildRecords(PluginAddress plugin, string cellFormKey, CancellationToken cancel);
    Answer<IReadOnlyList<InteriorCellBlock>, IndexRefused> GetInteriorCells(PluginAddress plugin, CancellationToken cancel);
    Answer<IReadOnlyList<ContainerChildSummary>, IndexRefused> GetContainerChildren(
        PluginAddress plugin, string parentFormKey, CancellationToken cancel);

    Answer<IReadOnlyList<PluginDiagnosisReport>, IndexRefused> GetLoadOrderDiagnoses(CancellationToken cancel);
    Answer<PluginDependants, IndexRefused> GetDependants(PluginAddress plugin, CancellationToken cancel);
    Answer<PluginIndexedState, IndexRefused> GetPluginIndexedAsOnDisk(PluginAddress plugin);
    Answer<IReadOnlyList<IndexOfPlugin>, IndexRefused> GetPluginsIndexing();
    Answer<IReadOnlyList<PluginProblems>, IndexRefused> GetProblems(PluginAddress? plugin, RecordsAsked? asked, CancellationToken cancel);
    Answer<IReadOnlyList<PluginFilePaths>, IndexRefused> GetFilePaths(PluginAddress? plugin, RecordsAsked? asked, CancellationToken cancel);

    /// <summary>Null once the record index holds each plugin <paramref name="written"/> names, or once a check of the disk has
    /// read it when null; otherwise why not (ADR-0029).</summary>
    Task<string?> Hold(IReadOnlyList<HandedPlugin>? written, CancellationToken cancel);

    // Answered in every state, "no load order yet" included (ADR-0013).
    LoadOrderStatus GetStatus();
    long GetSequence();
    Task<SequenceAwaitResponse> AwaitSequence(long atLeast, TimeSpan timeout);

    Answer<RecordFilter?, IndexRefused> GetFilter(CancellationToken cancel);
    // Replaces which compiled plugins of a mod changed outside Modbench (ADR-0003), and answers the plugins whose standing flipped.
    IReadOnlyList<PluginAddress> SetChangedOutside(string origin, IReadOnlyList<string> plugins);
    // Null when the filter was not cleared.
    FilterCleared? GetFilterCleared();
    // Why the SQL cannot be a filter, or no load order to hold it; null once it is in force.
    IndexRefused? SetFilter(string sql, string source);
    void ClearFilter();
    // The rows of one SELECT over the views of every plugin the record index holds, read as they are taken; the filter in force does not narrow them. The caller disposes them.
    Answer<SelectedRows, IndexRefused> SelectRows(string sql, CancellationToken cancel);
    // One object per name, in order; refused whole when any name means nothing or more than one thing.
    Answer<IReadOnlyList<NamedObject>, IndexRefused> ResolveNames(IReadOnlyList<NameQuery> names, CancellationToken cancel);
    StoreRebuildRefused? RebuildStore(GameRelease gameRelease, string instanceRoot);
}
