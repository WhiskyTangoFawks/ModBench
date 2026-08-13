using DuckDB.NET.Data;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests;

/// <summary>
/// Forwards every <see cref="IRecordRepository"/> member to a real one, so a test double only has to
/// state the member it actually cares about. The interface is wide (indexing plus every read path),
/// and a double that reimplements it is both a maintenance burden and a lie — these tests want real
/// DuckDB behaviour with one seam intercepted, not a fake database.
/// </summary>
internal abstract class DelegatingRecordRepository(IRecordRepository inner) : IRecordRepository
{
    protected IRecordRepository Inner { get; } = inner;

    public DuckDBConnection Connection => Inner.Connection;
    public virtual void SetFilter(string? sql) => Inner.SetFilter(sql);
    public virtual void Initialize(GameRelease release) => Inner.Initialize(release);

    public virtual void Index(IModGetter pluginMod, int loadOrderIndex, bool participates, string origin) =>
        Inner.Index(pluginMod, loadOrderIndex, participates, origin);
    public virtual void Unindex(string plugin, string origin) => Inner.Unindex(plugin, origin);
    public virtual void UpdateWinners() => Inner.UpdateWinners();
    public virtual void SetPluginParticipation(string plugin, bool participates, string origin) =>
        Inner.SetPluginParticipation(plugin, participates, origin);
    public virtual void Dispose() => Inner.Dispose();

    public PagedResult<RecordSummary> GetRecords(string tableName, string? plugin, string? search, int limit, int offset, string? origin = null) =>
        Inner.GetRecords(tableName, plugin, search, limit, offset, origin);
    public RecordDetail? GetRecord(string tableName, string formKey, string? plugin, string? origin, bool winnerOnly) =>
        Inner.GetRecord(tableName, formKey, plugin, origin, winnerOnly);
    public IReadOnlyList<RecordDetail> GetAllOverrides(string tableName, string formKey) =>
        Inner.GetAllOverrides(tableName, formKey);
    public VmadData? GetVmad(string formKey, string plugin, string origin) => Inner.GetVmad(formKey, plugin, origin);
    public IReadOnlyList<ConditionOwner> GetConditions(string formKey, string plugin, string origin) =>
        Inner.GetConditions(formKey, plugin, origin);
    public int CountRecordsForPlugin(string tableName, string plugin, string origin) =>
        Inner.CountRecordsForPlugin(tableName, plugin, origin);
    public string? FindRecordType(string formKey) => Inner.FindRecordType(formKey);
    public RecordLookupEntry? ResolveFormKey(string formKey) => Inner.ResolveFormKey(formKey);
    public IReadOnlyList<string> GetNativeFormKeys(string plugin, string origin) =>
        Inner.GetNativeFormKeys(plugin, origin);
    public PagedResult<RecordSummary> SearchRecords(IReadOnlyList<string> tableNames, string? plugin, string? search, int limit, int offset, string? origin = null) =>
        Inner.SearchRecords(tableNames, plugin, search, limit, offset, origin);
    public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames) =>
        Inner.GetPluginsWithMatchingRecords(tableNames);
    public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) => Inner.GetReferences(targetFormKey);
    public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(string plugin, string worldspaceFormKey, string origin) =>
        Inner.GetWorldspaceCells(plugin, worldspaceFormKey, origin);
    public PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset, string origin) =>
        Inner.GetInteriorCells(plugin, limit, offset, origin);
    public CellReferences GetCellReferences(string plugin, string cellFormKey, string origin) =>
        Inner.GetCellReferences(plugin, cellFormKey, origin);
    public PlacementRow? GetPlacement(string formKey, string plugin, string origin) =>
        Inner.GetPlacement(formKey, plugin, origin);
}
