using MEditService.Core.Queries;
using MEditService.Core.Records;

namespace MEditService.Tests;

/// <summary>
/// #639: <see cref="DelegatingRecordIndex"/>'s own posture ("one seam intercepted, not a fake
/// database"), applied one level down at the read surface an <see cref="IRecordIndex.At"/> call
/// hands out — needed because #639 moved every read off <see cref="IRecordIndex"/> itself, so a
/// double that used to override one <see cref="IRecordReads"/> member directly on
/// <see cref="IRecordIndex"/> (<c>DelegatingRecordIndex</c>'s own member, before this ticket) now has
/// to intercept it here instead, on whatever <see cref="IRecordReads"/> <see cref="At"/> returns.
/// Forwards every member to a real one, exactly like <see cref="DelegatingRecordIndex"/> does for the
/// wider index — a double that reimplements the whole read surface is both a maintenance burden and
/// a lie.
/// </summary>
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
