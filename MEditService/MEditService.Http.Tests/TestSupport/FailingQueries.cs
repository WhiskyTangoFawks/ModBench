using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>A face that fails every question; given a rebuild refusal, answers a rebuild with it.</summary>
internal sealed class FailingQueries(StoreRebuildRefused? rebuildRefusal = null) : IQueries
{
    public Answer<IReadOnlyList<PluginResponse>, IndexRefused> GetPlugins() => throw Failed();

    public Answer<PagedResult<RecordSummary>, IndexRefused> GetRecords(
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset) => throw Failed();

    public Answer<RecordDetail?, IndexRefused> GetRecord(string formKey) => throw Failed();

    public Answer<CompareResult?, IndexRefused> GetCompare(string formKey, CopyText? text = null) => throw Failed();

    public Answer<CompareRecordsAnswer, IndexRefused> GetCompareRecords(IReadOnlyList<RecordCopy> copies) => throw Failed();

    public Answer<bool, IndexRefused> GetPluginIndexedAsOnDisk(PluginAddress plugin) => throw Failed();
    public Answer<IReadOnlyList<PluginRecordTypeCount>, IndexRefused> GetPluginRecordTypes(PluginAddress plugin) => throw Failed();

    public Answer<WorkingTreeStatesBeneath, IndexRefused> GetWorkingTreeStatesBeneath(PluginAddress plugin) => throw Failed();

    public Answer<IReadOnlyList<RecordTypeChoice>, IndexRefused> GetCreatableRecordTypes() => throw Failed();

    public Answer<IReadOnlyList<string>, IndexRefused> GetCreatablePluginExtensions() => throw Failed();

    public Answer<IReadOnlyList<RecordTypeChoice>?, IndexRefused> GetChildRecordTypes(PluginAddress plugin, string formKey) => throw Failed();

    public Answer<IReadOnlyList<ReferenceResult>, IndexRefused> GetReferences(string targetFormKey) => throw Failed();
    public Answer<IReadOnlyList<ReferenceResult>, IndexRefused> GetReferencesInActiveOrCompiledPlugins(string targetFormKey) => throw Failed();

    public Answer<RenderedDocument?, IndexRefused> GetRenderedDocument(PluginAddress plugin, string formKey) => throw Failed();

    public Answer<CopyDocument?, IndexRefused> GetCopyDocument(PluginAddress plugin, string formKey) => throw Failed();

    public Answer<RecordOfFileAnswer, IndexRefused> GetRecordOfFile(string path) => throw Failed();

    public LoadOrderStatus GetStatus() => throw Failed();

    public long GetSequence() => throw Failed();

    public Task<SequenceAwaitResponse> AwaitSequence(long atLeast, TimeSpan timeout) => throw Failed();

    public Answer<RecordFilter?, IndexRefused> GetFilter() => throw Failed();

    public IndexRefused? SetFilter(string sql, string source) => throw Failed();

    public void ClearFilter() => throw Failed();

    public Answer<SelectedRows, IndexRefused> SelectRows(string sql) => throw Failed();

    public Answer<IReadOnlyList<NamedObject>, IndexRefused> ResolveNames(IReadOnlyList<NameQuery> names) => throw Failed();

    public StoreRebuildRefused? RebuildStore(GameRelease gameRelease, string instanceRoot) =>
        rebuildRefusal ?? throw Failed();

    public Answer<IReadOnlyList<WorldspaceSummary>, IndexRefused> GetWorldspaces(PluginAddress plugin) => throw Failed();

    public Answer<WorldspaceBlocks, IndexRefused> GetWorldspaceBlocks(PluginAddress plugin, string worldspaceFormKey) => throw Failed();

    public Answer<CellChildRecords, IndexRefused> GetCellChildRecords(PluginAddress plugin, string cellFormKey) => throw Failed();

    public Answer<IReadOnlyList<InteriorCellBlock>, IndexRefused> GetInteriorCells(PluginAddress plugin) => throw Failed();

    public Answer<IReadOnlyList<ContainerChildSummary>, IndexRefused> GetContainerChildren(PluginAddress plugin, string parentFormKey) =>
        throw Failed();

    public Answer<IReadOnlyList<PluginDiagnosisReport>, IndexRefused> GetLoadOrderDiagnoses() => throw Failed();

    public Answer<PluginDependants, IndexRefused> GetDependants(PluginAddress plugin) => throw Failed();

    public Answer<IReadOnlyList<PluginProblems>, IndexRefused> GetProblems() => throw Failed();

    internal static void Replace(IServiceCollection services, StoreRebuildRefused? rebuildRefusal = null) =>
        services.AddSingleton<IQueries>(new FailingQueries(rebuildRefusal));

    private static InvalidOperationException Failed() => new("The record index failed.");
}
