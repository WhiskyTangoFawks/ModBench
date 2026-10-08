using MEditService.Index;
using MEditService.Index.Queries;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>Query services that fail every question; given a rebuild refusal, answer a rebuild with
/// it, as another window's hold does.</summary>
internal sealed class FailingQueries(string? rebuildRefusal = null) : IRecordQueryService, IWorldspaceQueryService
{
    public IReadOnlyList<PluginRow> GetPlugins() => throw Failed();

    public PagedResult<RecordSummary> GetRecords(
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset) => throw Failed();

    public RecordDetail? GetRecord(string formKey) => throw Failed();

    public CompareResult? GetCompare(string formKey, CopyText? text = null) => throw Failed();

    public CompareResult? GetCompareRecords(IReadOnlyList<RecordCopy> copies) => throw Failed();

    public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(PluginAddress plugin) => throw Failed();

    public WorkingTreeStatesBeneath GetWorkingTreeStatesBeneath(PluginAddress plugin) => throw Failed();

    public IReadOnlyList<RecordTypeChoice> GetCreatableRecordTypes() => throw Failed();

    public IReadOnlyList<RecordTypeChoice>? GetChildRecordTypes(PluginAddress plugin, string formKey) => throw Failed();

    public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) => throw Failed();
    public IReadOnlyList<ReferenceResult> GetReferencesInActiveOrTrackedPlugins(string targetFormKey) => throw Failed();

    public RenderedDocument? GetRenderedDocument(PluginAddress plugin, string formKey) => throw Failed();

    public CopyDocument? GetCopyDocument(PluginAddress plugin, string formKey) => throw Failed();

    public RecordOfFileAnswer GetRecordOfFile(string path) => throw Failed();

    public LoadOrderStatus GetStatus() => throw Failed();

    public long GetSequence() => throw Failed();

    public Task<SequenceAwaitResponse> AwaitSequence(long atLeast, TimeSpan timeout) => throw Failed();

    public (string Sql, string Source)? GetFilter() => throw Failed();

    public void SetFilter(string sql, string source) => throw Failed();

    public void ClearFilter() => throw Failed();

    public StoreRebuildRefused? RebuildStore(GameRelease gameRelease, string instanceRoot) =>
        rebuildRefusal is null ? throw Failed() : new(StoreRebuildRefusal.HeldByAnotherWindow, rebuildRefusal);

    public IReadOnlyList<WorldspaceSummary> GetWorldspaces(PluginAddress plugin) => throw Failed();

    public WorldspaceBlocks GetWorldspaceBlocks(PluginAddress plugin, string worldspaceFormKey) => throw Failed();

    public CellChildRecords GetCellChildRecords(PluginAddress plugin, string cellFormKey) => throw Failed();

    public IReadOnlyList<InteriorCellBlock> GetInteriorCells(PluginAddress plugin) => throw Failed();

    internal static void Replace(IServiceCollection services, string? rebuildRefusal = null)
    {
        var failing = new FailingQueries(rebuildRefusal);
        services.AddSingleton<IRecordQueryService>(failing);
        services.AddSingleton<IWorldspaceQueryService>(failing);
        services.AddSingleton<ContainerChildQueryService>(_ => throw Failed());
    }

    private static InvalidOperationException Failed() => new("The index failed.");
}
