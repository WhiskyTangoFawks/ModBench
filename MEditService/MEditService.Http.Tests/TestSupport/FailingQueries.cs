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
    public Task<Answer<IReadOnlyList<PluginResponse>, IndexRefused>> GetPlugins(CancellationToken cancel) => throw Failed();

    public Task<Answer<PagedResult<RecordSummary>, IndexRefused>> GetRecords(
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset, CancellationToken cancel) =>
        throw Failed();

    public Task<Answer<RecordDetail?, IndexRefused>> GetRecord(string formKey, CancellationToken cancel) => throw Failed();

    public Task<Answer<CompareResult?, IndexRefused>> GetCompare(string formKey, CopyText? text, CancellationToken cancel) =>
        throw Failed();

    public Task<Answer<CompareRecordsAnswer, IndexRefused>> GetCompareRecords(IReadOnlyList<RecordCopy> copies, CancellationToken cancel) =>
        throw Failed();

    public Task<Answer<IReadOnlyList<RecordCopyStates>, IndexRefused>> GetCopyStates(
        IReadOnlyList<string> formKeys, PluginAddress? plugin, CancellationToken cancel) => throw Failed();

    public Answer<PluginIndexedState, IndexRefused> GetPluginIndexedAsOnDisk(PluginAddress plugin) => throw Failed();
    public Task<Answer<IReadOnlyList<PluginRecordTypeCount>, IndexRefused>> GetPluginRecordTypes(
        PluginAddress plugin, CancellationToken cancel) => throw Failed();

    public Task<Answer<WorkingTreeStatesBeneath, IndexRefused>> GetWorkingTreeStatesBeneath(
        PluginAddress plugin, CancellationToken cancel) => throw Failed();

    public Answer<IReadOnlyList<RecordTypeChoice>, IndexRefused> GetCreatableRecordTypes() => throw Failed();

    public Answer<IReadOnlyList<string>, IndexRefused> GetCreatablePluginExtensions() => throw Failed();
    public Answer<IReadOnlyList<IReadOnlyList<string>>, IndexRefused> GetCreatablePluginFlags(string name) => throw Failed();

    public Task<Answer<IReadOnlyList<RecordTypeChoice>?, IndexRefused>> GetChildRecordTypes(
        PluginAddress plugin, string formKey, CancellationToken cancel) => throw Failed();

    public Task<Answer<IReadOnlyList<ReferenceResult>, IndexRefused>> GetReferencesInActiveOrCompiledPlugins(
        string targetFormKey, CancellationToken cancel) => throw Failed();
    public Task<Answer<IReadOnlyList<CopyNaming>, IndexRefused>> GetPluginNameReferences(string name, CancellationToken cancel) =>
        throw Failed();
    public Answer<IReadOnlyList<RecordAt>, IndexRefused> GetCopiesWithNoPluginSourceNaming(PluginAddress plugin, string formKey) => throw Failed();
    public Task<Answer<MemberReferences, IndexRefused>> GetScriptReferences(string name, CancellationToken cancel) => throw Failed();
    public Task<Answer<MemberReferences, IndexRefused>> GetFileReferences(string dataPath, CancellationToken cancel) => throw Failed();

    public Task<Answer<RenderedDocument?, IndexRefused>> GetRenderedDocument(
        PluginAddress plugin, string formKey, CancellationToken cancel) => throw Failed();

    public Task<Answer<CopyDocument?, IndexRefused>> GetCopyDocument(PluginAddress plugin, string formKey, CancellationToken cancel) =>
        throw Failed();

    public Answer<RecordOfFileAnswer, IndexRefused> GetRecordOfFile(string path) => throw Failed();

    public LoadOrderStatus GetStatus() => throw Failed();

    public long GetSequence() => throw Failed();

    public Task<SequenceAwaitResponse> AwaitSequence(long atLeast, TimeSpan timeout) => throw Failed();

    public Answer<RecordFilter?, IndexRefused> GetFilter() => throw Failed();

    public IndexRefused? SetFilter(string sql, string source) => throw Failed();

    public void ClearFilter() => throw Failed();

    public Task<Answer<SelectedRows, IndexRefused>> SelectRows(string sql, CancellationToken cancel) => throw Failed();

    public Task<Answer<IReadOnlyList<NamedObject>, IndexRefused>> ResolveNames(IReadOnlyList<NameQuery> names, CancellationToken cancel) =>
        throw Failed();

    public StoreRebuildRefused? RebuildStore(GameRelease gameRelease, string instanceRoot) =>
        rebuildRefusal ?? throw Failed();

    public Task<Answer<IReadOnlyList<WorldspaceSummary>, IndexRefused>> GetWorldspaces(PluginAddress plugin, CancellationToken cancel) =>
        throw Failed();

    public Task<Answer<WorldspaceBlocks, IndexRefused>> GetWorldspaceBlocks(
        PluginAddress plugin, string worldspaceFormKey, CancellationToken cancel) => throw Failed();

    public Task<Answer<CellChildRecords, IndexRefused>> GetCellChildRecords(
        PluginAddress plugin, string cellFormKey, CancellationToken cancel) => throw Failed();

    public Task<Answer<IReadOnlyList<InteriorCellBlock>, IndexRefused>> GetInteriorCells(PluginAddress plugin, CancellationToken cancel) =>
        throw Failed();

    public Task<Answer<IReadOnlyList<ContainerChildSummary>, IndexRefused>> GetContainerChildren(
        PluginAddress plugin, string parentFormKey, CancellationToken cancel) => throw Failed();

    public Task<Answer<IReadOnlyList<PluginDiagnosisReport>, IndexRefused>> GetLoadOrderDiagnoses(CancellationToken cancel) =>
        throw Failed();

    public Task<Answer<PluginDependants, IndexRefused>> GetDependants(PluginAddress plugin, CancellationToken cancel) => throw Failed();

    public Task<Answer<IReadOnlyList<PluginProblems>, IndexRefused>> GetProblems(PluginAddress? plugin, CancellationToken cancel) => throw Failed();
    public Task<Answer<IReadOnlyList<PluginFilePaths>, IndexRefused>> GetFilePaths(PluginAddress? plugin, CancellationToken cancel) =>
        throw Failed();

    internal static void Replace(IServiceCollection services, StoreRebuildRefused? rebuildRefusal = null) =>
        services.AddSingleton<IQueries>(new FailingQueries(rebuildRefusal));

    private static InvalidOperationException Failed() => new("The record index failed.");
}
