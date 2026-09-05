using MEditService.Core.Queries;
using MEditService.Core.Records;

namespace MEditService.Tests;

/// <summary>Forwards every <see cref="IRecordReads"/> member to a real one, so a double intercepts
/// one read on whatever <c>IRecordIndex.At</c> hands out rather than reimplementing the surface.</summary>
internal abstract class DelegatingReads(IRecordReads inner) : IRecordReads
{
    protected IRecordReads Inner { get; } = inner;

    public virtual RecordDocument? GetDocument(string formKey) => Inner.GetDocument(formKey);
    public virtual RecordDocument? GetDocument(string formKey, PluginKey plugin) => Inner.GetDocument(formKey, plugin);
    public virtual IReadOnlyList<RecordDocument> GetDocuments(PluginKey plugin) => Inner.GetDocuments(plugin);
    public virtual RecordOverrides? GetOverrideStack(string formKey) => Inner.GetOverrideStack(formKey);
    public virtual PagedResult<RecordSummary> Search(RecordQuery query) => Inner.Search(query);
    public virtual IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginKey plugin) => Inner.GetRecordTypeCounts(plugin);
    public virtual RecordLookupEntry? Resolve(string formKey) => Inner.Resolve(formKey);
    public virtual IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey) => Inner.GetReferencedBy(targetFormKey);
    public virtual IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames) =>
        Inner.GetPluginsWithMatchingRecords(tableNames);

    public virtual IReadOnlySet<string> GetPluginsWithParseFailures() => Inner.GetPluginsWithParseFailures();
    public virtual IReadOnlyList<string> GetNativeFormKeys(PluginKey plugin) => Inner.GetNativeFormKeys(plugin);
    public virtual IReadOnlyList<string> GetEffectiveMasters(PluginKey plugin) => Inner.GetEffectiveMasters(plugin);
    public virtual IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginKey plugin, string worldspaceFormKey) =>
        Inner.GetWorldspaceCells(plugin, worldspaceFormKey);
    public virtual PagedResult<CellSummary> GetInteriorCells(PluginKey plugin, int limit, int offset) =>
        Inner.GetInteriorCells(plugin, limit, offset);
    public virtual CellReferences GetCellReferences(PluginKey plugin, string cellFormKey) =>
        Inner.GetCellReferences(plugin, cellFormKey);
    public virtual PlacementRow? GetPlacement(string formKey, PluginKey plugin) => Inner.GetPlacement(formKey, plugin);
    public virtual CellLocationRow? GetCellLocation(PluginKey plugin, string cellFormKey) => Inner.GetCellLocation(plugin, cellFormKey);
    public virtual IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginKey plugin, string parentFormKey) =>
        Inner.GetContainerChildren(plugin, parentFormKey);
    public virtual ContainerChildRow? GetContainerParent(PluginKey plugin, string childFormKey) =>
        Inner.GetContainerParent(plugin, childFormKey);
}
