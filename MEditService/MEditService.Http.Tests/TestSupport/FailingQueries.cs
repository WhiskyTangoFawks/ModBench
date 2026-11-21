using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>A face that fails every question; given a rebuild refusal, answers a rebuild with it, and given an index
/// refusal, answers who holds a record with it.</summary>
internal sealed class FailingQueries(StoreRebuildRefused? rebuildRefusal = null, IndexRefused? ownersRefused = null) : IQueries
{
    public Answer<IReadOnlyList<PluginResponse>, IndexRefused> GetPlugins(IReadOnlyCollection<PluginAddress>? plugins, CancellationToken cancel) => throw Failed();

    public Answer<PagedResult<RecordSummary>, IndexRefused> GetRecords(
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset, CancellationToken cancel) =>
        throw Failed();

    public Answer<IReadOnlyDictionary<string, IReadOnlyList<PluginAddress>>, IndexRefused> GetRecordOwners(
        IReadOnlyCollection<string> formKeys, CancellationToken cancel) =>
        ownersRefused ?? throw Failed();

    public Answer<DecidedOwners, IndexRefused> GetRecordOwnersForAWrite(IReadOnlyCollection<string> formKeys, CancellationToken cancel) =>
        ownersRefused ?? throw Failed();

    public Answer<IReadOnlyList<string>, IndexRefused> GetPlacesHoldingPluginSource(string name) => throw Failed();

    public Answer<CompareResult?, IndexRefused> GetCompare(string formKey, CopyText? text, CancellationToken cancel) =>
        throw Failed();

    public Answer<CompareRecordsAnswer, IndexRefused> GetCompareRecords(IReadOnlyList<RecordCopy> copies, CancellationToken cancel) =>
        throw Failed();

    public Answer<IReadOnlyList<RecordCopyStates>, IndexRefused> GetCopyStates(
        IReadOnlyList<string> formKeys, PluginAddress? plugin, CancellationToken cancel) => throw Failed();

    public Answer<PluginIndexedState, IndexRefused> GetPluginIndexedAsOnDisk(PluginAddress plugin) => throw Failed();
    public Answer<IReadOnlyList<IndexOfPlugin>, IndexRefused> GetPluginsIndexing() => throw Failed();
    public Answer<IReadOnlyList<PluginRecordTypeCount>, IndexRefused> GetPluginRecordTypes(
        PluginAddress plugin, CancellationToken cancel) => throw Failed();

    public Answer<WorkingTreeStatesBeneath, IndexRefused> GetWorkingTreeStatesBeneath(
        PluginAddress plugin, CancellationToken cancel) => throw Failed();

    public Answer<IReadOnlyList<RecordTypeChoice>, IndexRefused> GetCreatableRecordTypes() => throw Failed();

    public Answer<IReadOnlyList<string>, IndexRefused> GetCreatablePluginExtensions() => throw Failed();
    public Answer<IReadOnlyList<IReadOnlyList<string>>, IndexRefused> GetCreatablePluginFlags(string name) => throw Failed();

    public Answer<IReadOnlyList<RecordTypeChoice>?, IndexRefused> GetChildRecordTypes(
        PluginAddress plugin, string formKey, CancellationToken cancel) => throw Failed();

    public Answer<IReadOnlyList<ReferenceResult>, IndexRefused> GetReferencesInActiveOrCompiledPlugins(
        string targetFormKey, CancellationToken cancel) => throw Failed();
    public Answer<PlacedReferences, IndexRefused> GetPlacedReferences(string targetFormKey, CancellationToken cancel) => throw Failed();
    public Answer<IReadOnlyList<CopyNaming>, IndexRefused> GetPluginNameReferences(string name, CancellationToken cancel) =>
        throw Failed();
    public Answer<IReadOnlyList<RecordAt>, IndexRefused> GetCopiesWithNoPluginSourceNaming(PluginAddress plugin, string formKey, CancellationToken cancel) => throw Failed();
    public Answer<MemberReferences, IndexRefused> GetScriptReferences(string name, CancellationToken cancel) => throw Failed();
    public Answer<PlacedReferences, IndexRefused> GetPlacedPluginNameReferences(string name, CancellationToken cancel) => throw Failed();
    public Answer<PlacedReferences, IndexRefused> GetPlacedScriptReferences(string name, CancellationToken cancel) => throw Failed();
    public Answer<PlacedReferences, IndexRefused> GetPlacedFileReferences(string dataPath, CancellationToken cancel) => throw Failed();

    public Answer<RenderedDocument?, IndexRefused> GetRenderedDocument(
        PluginAddress plugin, string formKey, CancellationToken cancel) => throw Failed();

    public Answer<CopyDocument?, IndexRefused> GetCopyDocument(PluginAddress plugin, string formKey, CancellationToken cancel) =>
        throw Failed();

    public Answer<CopyDocument?, IndexRefused> GetCopyDocument(PluginAddress plugin, RecordIdentity identity, CancellationToken cancel) =>
        throw Failed();

    public Answer<RecordOfFileAnswer, IndexRefused> GetRecordOfFile(string path) => throw Failed();

    public Answer<IReadOnlyList<DocumentName>, IndexRefused> GetPluginSourceNames(string? path, string text, int? at, CancellationToken cancel) => throw Failed();

    public Task<string?> Hold(IReadOnlyList<HandedPlugin>? written, CancellationToken cancel) => throw Failed();

    public LoadOrderStatus GetStatus() => throw Failed();

    public long GetSequence() => throw Failed();

    public Task<SequenceAwaitResponse> AwaitSequence(long atLeast, TimeSpan timeout) => throw Failed();

    public Answer<RecordFilter?, IndexRefused> GetFilter(CancellationToken cancel) => throw Failed();
    public FilterCleared? GetFilterCleared() => throw Failed();
    public IReadOnlyList<PluginAddress> SetChangedOutside(string origin, IReadOnlyList<string> plugins) => throw Failed();

    public IndexRefused? SetFilter(string sql, string source) => throw Failed();

    public void ClearFilter() => throw Failed();

    public Answer<SelectedRows, IndexRefused> SelectRows(string sql, CancellationToken cancel) => throw Failed();

    public Answer<IReadOnlyList<NamedObject>, IndexRefused> ResolveNames(IReadOnlyList<NameQuery> names, CancellationToken cancel) =>
        throw Failed();

    public StoreRebuildRefused? RebuildStore(GameRelease gameRelease, string instanceRoot) =>
        rebuildRefusal ?? throw Failed();

    public Answer<IReadOnlyList<WorldspaceSummary>, IndexRefused> GetWorldspaces(PluginAddress plugin, CancellationToken cancel) =>
        throw Failed();

    public Answer<WorldspaceBlocks, IndexRefused> GetWorldspaceBlocks(
        PluginAddress plugin, string worldspaceFormKey, CancellationToken cancel) => throw Failed();

    public Answer<CellChildRecords, IndexRefused> GetCellChildRecords(
        PluginAddress plugin, string cellFormKey, CancellationToken cancel) => throw Failed();

    public Answer<IReadOnlyList<InteriorCellBlock>, IndexRefused> GetInteriorCells(PluginAddress plugin, CancellationToken cancel) =>
        throw Failed();

    public Answer<IReadOnlyList<ContainerChildSummary>, IndexRefused> GetContainerChildren(
        PluginAddress plugin, string parentFormKey, CancellationToken cancel) => throw Failed();

    public Answer<IReadOnlyList<PluginDiagnosisReport>, IndexRefused> GetLoadOrderDiagnoses(CancellationToken cancel) =>
        throw Failed();

    public Answer<PluginDependants, IndexRefused> GetDependants(PluginAddress plugin, CancellationToken cancel) => throw Failed();

    public Answer<IReadOnlyList<PluginProblems>, IndexRefused> GetProblems(PluginAddress? plugin, RecordsAsked? asked, CancellationToken cancel) => throw Failed();
    public Answer<IReadOnlyList<PluginFilePaths>, IndexRefused> GetFilePaths(PluginAddress? plugin, RecordsAsked? asked, CancellationToken cancel) =>
        throw Failed();

    internal static void Replace(IServiceCollection services, StoreRebuildRefused? rebuildRefusal = null, IndexRefused? ownersRefused = null) =>
        services.AddSingleton<IQueries>(new FailingQueries(rebuildRefusal, ownersRefused));

    private static InvalidOperationException Failed() => new("The record index failed.");
}
